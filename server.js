const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'proxy-config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const fileData = fs.readFileSync(CONFIG_FILE, 'utf8');
      config = JSON.parse(fileData);
      log('info', `Config loaded from ${CONFIG_FILE}`);
    } else {
      saveConfig();
      log('info', `Default config created at ${CONFIG_FILE}`);
    }
  } catch (err) {
    log('error', `Failed to load config: ${err.message}`);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    log('info', `Config saved to ${CONFIG_FILE}`);
    return true;
  } catch (err) {
    log('error', `Failed to save config: ${err.message}`);
    return false;
  }
}

function setupLogging() {
  if (config.logging.enabled && config.logging.logToFile) {
    try {
      if (!fs.existsSync(config.logging.logPath)) {
        fs.mkdirSync(config.logging.logPath, { recursive: true });
      }
    } catch (err) {
      console.error(`Failed to create log directory: ${err.message}`);
      config.logging.logToFile = false;
    }
  }
}

function log(level, message) {
  if (!config.logging.enabled) return;
  
  const logLevels = {
    'error': 3,
    'warn': 2,
    'info': 1
  };
  
  if (logLevels[level] < logLevels[config.logging.logLevel]) return;
  
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  
  console.log(logMessage);
  
  if (config.logging.logToFile) {
    try {
      const logFile = path.join(config.logging.logPath, `proxy-${new Date().toISOString().split('T')[0]}.log`);
      fs.appendFileSync(logFile, logMessage + '\n');
    } catch (err) {
      console.error(`Failed to write to log file: ${err.message}`);
    }
  }
}

function startTcpProxy(route) {
  for (const existingRoute of activeServers) {
    if (existingRoute.protocol === 'tcp' && 
        existingRoute.listen.port === route.listen.port &&
        existingRoute.listen.host === route.listen.host) {
      log('warn', `TCP proxy for ${route.name} cannot start: Address already in use`);
      return null;
    }
  }

  try {
    const tcpServer = net.createServer((clientSocket) => {
      log('info', `[${route.name}] TCP connection from ${clientSocket.remoteAddress}:${clientSocket.remotePort}`);
      
      let serverSocket;
      try {
        serverSocket = net.connect({
          host: route.forward.host,
          port: route.forward.port
        }, () => {
          log('info', `[${route.name}] TCP connected to destination ${route.forward.host}:${route.forward.port}`);
        });
        
        clientSocket.pipe(serverSocket);
        serverSocket.pipe(clientSocket);
        
        clientSocket.on('error', (err) => {
          log('error', `[${route.name}] TCP client socket error: ${err.message}`);
          if (serverSocket) serverSocket.end();
        });
        
        serverSocket.on('error', (err) => {
          log('error', `[${route.name}] TCP server socket error: ${err.message}`);
          clientSocket.end();
        });
        
        clientSocket.on('close', () => {
          log('info', `[${route.name}] TCP client disconnected: ${clientSocket.remoteAddress}:${clientSocket.remotePort}`);
          if (serverSocket) serverSocket.end();
        });
        
        serverSocket.on('close', () => {
          log('info', `[${route.name}] TCP server connection closed to ${route.forward.host}:${route.forward.port}`);
          clientSocket.end();
        });
      } catch (err) {
        log('error', `[${route.name}] Failed to connect to destination: ${err.message}`);
        clientSocket.end();
      }
    });
    
    tcpServer.listen(route.listen.port, route.listen.host, () => {
      log('info', `[${route.name}] TCP proxy listening on ${route.listen.host}:${route.listen.port} -> ${route.forward.host}:${route.forward.port}`);
    });
    
    tcpServer.on('error', (err) => {
      log('error', `[${route.name}] TCP server error: ${err.message}`);
      activeServers = activeServers.filter(s => s.server !== tcpServer);
    });
    
    return tcpServer;
  } catch (err) {
    log('error', `[${route.name}] Failed to start TCP proxy: ${err.message}`);
    return null;
  }
}

function startUdpProxy(route) {
  for (const existingRoute of activeServers) {
    if (existingRoute.protocol === 'udp' && 
        existingRoute.listen.port === route.listen.port &&
        existingRoute.listen.host === route.listen.host) {
      log('warn', `UDP proxy for ${route.name} cannot start: Address already in use`);
      return null;
    }
  }

  try {
    const udpServer = dgram.createSocket('udp4');
    const clients = new Map();
    
    udpServer.on('listening', () => {
      const address = udpServer.address();
      log('info', `[${route.name}] UDP proxy listening on ${address.address}:${address.port} -> ${route.forward.host}:${route.forward.port}`);
    });
    
    udpServer.on('message', (message, rinfo) => {
      const clientKey = `${rinfo.address}:${rinfo.port}`;
      
      if (!clients.has(clientKey)) {
        log('info', `[${route.name}] UDP client connected: ${clientKey}`);
        
        let clientSocket;
        try {
          clientSocket = dgram.createSocket('udp4');
          
          clientSocket.on('message', (forwardedMessage, forwardedRinfo) => {
            udpServer.send(forwardedMessage, rinfo.port, rinfo.address, (err) => {
              if (err) log('error', `[${route.name}] UDP send error to client: ${err.message}`);
            });
          });
          
          clientSocket.on('error', (err) => {
            log('error', `[${route.name}] UDP client socket error for ${clientKey}: ${err.message}`);
            clientSocket.close();
            clients.delete(clientKey);
          });
          
          const timeout = setTimeout(() => {
            if (clients.has(clientKey)) {
              log('info', `[${route.name}] UDP client ${clientKey} timed out after ${config.udpTimeout/1000} seconds of inactivity`);
              clientSocket.close();
              clients.delete(clientKey);
            }
          }, config.udpTimeout);
          
          clients.set(clientKey, { socket: clientSocket, timeout });
        } catch (err) {
          log('error', `[${route.name}] Failed to create UDP client socket: ${err.message}`);
          return;
        }
      }
      
      if (clients.has(clientKey)) {
        clearTimeout(clients.get(clientKey).timeout);
        clients.get(clientKey).timeout = setTimeout(() => {
          if (clients.has(clientKey)) {
            log('info', `[${route.name}] UDP client ${clientKey} timed out after ${config.udpTimeout/1000} seconds of inactivity`);
            clients.get(clientKey).socket.close();
            clients.delete(clientKey);
          }
        }, config.udpTimeout);
        
        try {
          clients.get(clientKey).socket.send(message, route.forward.port, route.forward.host, (err) => {
            if (err) log('error', `[${route.name}] UDP send error to server: ${err.message}`);
          });
        } catch (err) {
          log('error', `[${route.name}] UDP send error: ${err.message}`);
        }
      }
    });
    
    udpServer.on('error', (err) => {
      log('error', `[${route.name}] UDP server error: ${err.message}`);
      try {
        udpServer.close();
      } catch (closeErr) {
        log('error', `[${route.name}] Error closing UDP server: ${closeErr.message}`);
      }
      activeServers = activeServers.filter(s => s.server !== udpServer);
    });
    
    try {
      udpServer.bind(route.listen.port, route.listen.host);
      return { server: udpServer, clients };
    } catch (err) {
      log('error', `[${route.name}] Failed to bind UDP server: ${err.message}`);
      return null;
    }
  } catch (err) {
    log('error', `[${route.name}] Failed to start UDP proxy: ${err.message}`);
    return null;
  }
}

let activeServers = [];

function startAllProxies() {
  stopAllProxies();
  
  for (const route of config.routes) {
    if (route.enabled) {
      let server = null;
      
      if (route.protocol === 'tcp') {
        server = startTcpProxy(route);
      } else if (route.protocol === 'udp') {
        server = startUdpProxy(route);
      }
      
      if (server) {
        activeServers.push({
          name: route.name,
          protocol: route.protocol,
          listen: route.listen,
          forward: route.forward,
          server: server
        });
      }
    }
  }
  
  log('info', `Started ${activeServers.length} proxies`);
}

function stopAllProxies() {
  for (const server of activeServers) {
    try {
      if (server.protocol === 'tcp') {
        server.server.close();
      } else if (server.protocol === 'udp') {
        // بستن سوکت‌های مشتری UDP
        if (server.server.clients) {
          for (const [clientKey, client] of server.server.clients) {
            clearTimeout(client.timeout);
            client.socket.close();
          }
        }
        server.server.close();
      }
      
      log('info', `Stopped ${server.protocol.toUpperCase()} proxy ${server.name}`);
    } catch (err) {
      log('error', `Failed to stop ${server.protocol.toUpperCase()} proxy ${server.name}: ${err.message}`);
    }
  }
  
  activeServers = [];
}

const routeManager = {
  addRoute(routeConfig) {
    const existingRoute = config.routes.find(r => r.name === routeConfig.name);
    if (existingRoute) {
      return { success: false, message: `Route with name ${routeConfig.name} already exists` };
    }
    
    config.routes.push(routeConfig);
    saveConfig();
    
    if (routeConfig.enabled) {
      let server = null;
      if (routeConfig.protocol === 'tcp') {
        server = startTcpProxy(routeConfig);
      } else if (routeConfig.protocol === 'udp') {
        server = startUdpProxy(routeConfig);
      }
      
      if (server) {
        activeServers.push({
          name: routeConfig.name,
          protocol: routeConfig.protocol,
          listen: routeConfig.listen,
          forward: routeConfig.forward,
          server: server
        });
      }
    }
    
    return { success: true, message: `Route ${routeConfig.name} added successfully` };
  },
  
  removeRoute(routeName) {
    const routeIndex = config.routes.findIndex(r => r.name === routeName);
    if (routeIndex === -1) {
      return { success: false, message: `Route ${routeName} not found` };
    }
    
    const activeServer = activeServers.find(s => s.name === routeName);
    if (activeServer) {
      try {
        if (activeServer.protocol === 'tcp') {
          activeServer.server.close();
        } else if (activeServer.protocol === 'udp') {
          activeServer.server.close();
        }
        activeServers = activeServers.filter(s => s.name !== routeName);
      } catch (err) {
        log('error', `Failed to stop server for route ${routeName}: ${err.message}`);
      }
    }
    
    config.routes.splice(routeIndex, 1);
    saveConfig();
    
    return { success: true, message: `Route ${routeName} removed successfully` };
  },
  
  updateRoute(routeName, routeConfig) {
    const routeIndex = config.routes.findIndex(r => r.name === routeName);
    if (routeIndex === -1) {
      return { success: false, message: `Route ${routeName} not found` };
    }
    
    const wasEnabled = config.routes[routeIndex].enabled;
    
    config.routes[routeIndex] = { ...routeConfig, name: routeName };
    saveConfig();
    
    const activeServer = activeServers.find(s => s.name === routeName);
    
    if (activeServer) {
      try {
        if (activeServer.protocol === 'tcp') {
          activeServer.server.close();
        } else if (activeServer.protocol === 'udp') {
          activeServer.server.close();
        }
        activeServers = activeServers.filter(s => s.name !== routeName);
      } catch (err) {
        log('error', `Failed to stop server for route ${routeName}: ${err.message}`);
      }
    }
    
    if (routeConfig.enabled) {
      let server = null;
      if (routeConfig.protocol === 'tcp') {
        server = startTcpProxy(routeConfig);
      } else if (routeConfig.protocol === 'udp') {
        server = startUdpProxy(routeConfig);
      }
      
      if (server) {
        activeServers.push({
          name: routeName,
          protocol: routeConfig.protocol,
          listen: routeConfig.listen,
          forward: routeConfig.forward,
          server: server
        });
      }
    }
    
    return { success: true, message: `Route ${routeName} updated successfully` };
  },
  
  toggleRoute(routeName) {
    const routeIndex = config.routes.findIndex(r => r.name === routeName);
    if (routeIndex === -1) {
      return { success: false, message: `Route ${routeName} not found` };
    }
    
    config.routes[routeIndex].enabled = !config.routes[routeIndex].enabled;
    saveConfig();
    
    const isEnabled = config.routes[routeIndex].enabled;
    const activeServer = activeServers.find(s => s.name === routeName);
    
    if (isEnabled && !activeServer) {
      const route = config.routes[routeIndex];
      let server = null;
      
      if (route.protocol === 'tcp') {
        server = startTcpProxy(route);
      } else if (route.protocol === 'udp') {
        server = startUdpProxy(route);
      }
      
      if (server) {
        activeServers.push({
          name: routeName,
          protocol: route.protocol,
          listen: route.listen,
          forward: route.forward,
          server: server
        });
      }
      
      return { success: true, message: `Route ${routeName} enabled` };
    } else if (!isEnabled && activeServer) {
      try {
        if (activeServer.protocol === 'tcp') {
          activeServer.server.close();
        } else if (activeServer.protocol === 'udp') {
          activeServer.server.close();
        }
        activeServers = activeServers.filter(s => s.name !== routeName);
      } catch (err) {
        log('error', `Failed to stop server for route ${routeName}: ${err.message}`);
      }
      
      return { success: true, message: `Route ${routeName} disabled` };
    }
    
    return { success: true, message: `Route ${routeName} status unchanged` };
  },
  
  getAllRoutes() {
    return config.routes.map(route => ({
      ...route,
      active: activeServers.some(s => s.name === route.name)
    }));
  }
};

const http = require('http');
const url = require('url');

function startApiServer(port = 8080) {
  const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const path = parsedUrl.pathname;
    const method = req.method;
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (method === 'OPTIONS') {
      res.statusCode = 200;
      res.end();
      return;
    }
    
    if (method === 'POST' || method === 'PUT') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          handleApiRequest(method, path, data, res);
        } catch (err) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
        }
      });
    } else {
      handleApiRequest(method, path, parsedUrl.query, res);
    }
  });
  
  server.listen(port, () => {
    log('info', `API server running on port ${port}`);
  });
  
  server.on('error', (err) => {
    log('error', `API server error: ${err.message}`);
  });
  
  return server;
}

function handleApiRequest(method, path, data, res) {
  try {
    if (path === '/routes' && method === 'GET') {
      const routes = routeManager.getAllRoutes();
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, routes }));
    }
    else if (path === '/routes' && method === 'POST') {
      if (!data.name || !data.protocol || !data.listen || !data.forward) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, message: 'Missing required fields' }));
        return;
      }
      
      const result = routeManager.addRoute({
        name: data.name,
        protocol: data.protocol,
        listen: {
          host: data.listen.host || '0.0.0.0',
          port: parseInt(data.listen.port)
        },
        forward: {
          host: data.forward.host,
          port: parseInt(data.forward.port)
        },
        enabled: data.enabled !== false
      });
      
      res.statusCode = result.success ? 201 : 400;
      res.end(JSON.stringify(result));
    }
    else if (path.startsWith('/routes/') && method === 'PUT') {
      const routeName = path.split('/')[2];
      
      if (!data.protocol || !data.listen || !data.forward) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, message: 'Missing required fields' }));
        return;
      }
      
      const result = routeManager.updateRoute(routeName, {
        protocol: data.protocol,
        listen: {
          host: data.listen.host || '0.0.0.0',
          port: parseInt(data.listen.port)
        },
        forward: {
          host: data.forward.host,
          port: parseInt(data.forward.port)
        },
        enabled: data.enabled !== false
      });
      
      res.statusCode = result.success ? 200 : 404;
      res.end(JSON.stringify(result));
    }
    else if (path.startsWith('/routes/') && method === 'DELETE') {
      const routeName = path.split('/')[2];
      const result = routeManager.removeRoute(routeName);
      
      res.statusCode = result.success ? 200 : 404;
      res.end(JSON.stringify(result));
    }
    else if (path.startsWith('/routes/') && path.endsWith('/toggle') && method === 'POST') {
      const routeName = path.split('/')[2];
      const result = routeManager.toggleRoute(routeName);
      
      res.statusCode = result.success ? 200 : 404;
      res.end(JSON.stringify(result));
    }
    else if (path === '/restart' && method === 'POST') {
      stopAllProxies();
      startAllProxies();
      
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, message: 'All proxies restarted' }));
    }
    else {
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, message: 'Not found' }));
    }
  } catch (err) {
    log('error', `API error: ${err.message}`);
    res.statusCode = 500;
    res.end(JSON.stringify({ success: false, message: 'Internal server error' }));
  }
}

function start() {
  loadConfig();
  
  setupLogging();
  
  startAllProxies();
  
  log('info', 'Proxy server started');
}

process.on('SIGINT', () => {
  log('info', 'Shutting down proxy...');
  stopAllProxies();
  process.exit();
});

start();