const { exec, spawn } = require('child_process');
const http = require('http').createServer(responseHandler);
const fs = require('fs'); //require filesystem module
const io = require('socket.io')(http) //require socket.io module and pass the http object (server)
const Gpio = require('onoff').Gpio; //include onoff to interact with the GPIO
const Humiture = require('node-dht-sensor');
const localtunnel = require('localtunnel');

const LogLevel = { none: 0, important: 1, medium: 2, verbose: 3 };
const PhotoresistorValueStatuses = { Good: 187, Medium: 200, LightDark: 217, Dark: 255, ItBecameBlackhole:  Number.POSITIVE_INFINITY };
const BulbControlModes = { sensor: 1, manual: 2 }
const debug_ = LogLevel.important;
const DELAY = 5 * 60 * 1000;
const ON = 1;
const OFF = Number(!ON);
const _port = 8080;
var _localTunnelInstance = null;
var _localProxyStatus = 'Uninitialized';
var _optocoupler_pin = 16;
const _subdomain = 'whats-up-homie';
var _subdomainCounter = 0;
const valuesJsonPath = `${__dirname}/data/values.json`;
var _values = {};
try {
   _values = JSON.parse(fs.readFileSync(valuesJsonPath, 'utf8'));
} 
catch (error) {
   log('Error on reading values.', error);
}

http.listen(_port);
log(`Node server stated. Port ${_port}.`)
startLocalhostProxy();

process.on('warning', e => console.warn(e.stack));
process.on('SIGINT', () => {
   _localTunnelInstance ? _localTunnelInstance.close() : null;
   log('Node server exiting.');
   process.exit();
});

function responseHandler(req, res) {
   // read file index.html in public folder
   fs.readFile(__dirname + '/public/index.html', function(err, data) {
      if (err) { // file not found
         log('Error occurred on getting index.html file.', err)
         res.writeHead(404, { 'Content-Type': 'text/html' }); //display 404 on error
         return res.end("404 Not Found");
      }

      res.writeHead(200, { 'Content-Type': 'text/html' }); //write HTML
      res.write(data); // Write html string
      res.end();
   });
}

// Register all pub-sub in socket
io.sockets.on('connection', function (socket) { // WebSocket Connection
   log('socket connection established.');
   
   fs.mkdir(__dirname + '/output', () => {/*callback is required*/});

   emitPeriodicData(socket);
   setInterval(emitPeriodicData, DELAY, socket);

   // Get bulb control mode from client
   socket.on('bulb-control-mode', function (data) {
      _values.bulbControlMode = data.value;
      fs.writeFile(valuesJsonPath, JSON.stringify(_values), () => {});
      
      // If sensor mode activated, check the sensor value and take action
      if(_values.bulbControlMode === BulbControlModes.sensor) {
         executePythonScript('photoresistor_with_a2d.py', toNumber)
            .then(data => {
               _values.bulbStatus = controlBulb(data.value, _values.bulbControlMode, _values.bulbStatus);
               // send to all connected clients
               socket.emit('bulb-status--from-server', { from: 'server', value: _values.bulbStatus, to: 'all' });
            })
            .catch(data => {});
      }
   });

   // Turn on/off the bulb from client
   socket.on('bulb-status--from-client', function (data) {
      if(_values.bulbControlMode !== BulbControlModes.manual)
         return;
      
      try {
         _values.bulbStatus = controlBulb(data.value, _values.bulbControlMode, _values.bulbStatus);
         fs.writeFileSync(valuesJsonPath, JSON.stringify(_values));
      }
      catch(err) {
         log('Error while switching bulb pin.', err, _values, data);
      }

      // broadcast to all connected sites about the change
      socket.broadcast.emit('bulb-status--from-server', { from: 'server', value: _values.bulbStatus, to: 'braodcast' });
   });

   socket.on('pi-stat', function () {
      getPiHealthData()
         .then(data => socket.emit('pi-stat', { from: 'server', piHealthData: data, to: 'connectee' }))
         .catch(data => socket.emit('pi-state', { from: 'server', piHealthData: data, to: 'connectee' }));
   });

   socket.on('terminate-app', function () {
      log('terminate-app...');
      try {
         log('Node server exiting!');
         _localTunnelInstance ? _localTunnelInstance.close() : null;
         process.exit();
      }
      catch (err) {
         if(debug_ >= LogLevel.important)
            log('Error on terminating Node!', err.toJsonString());
      }
   });
   
   socket.on('reboot', function () {
      log('rebooting...');
      exec('sudo reboot', (error, data) => {
            if(error && debug_ >= LogLevel.important)
               log({errorOnReboot: error, data});
         });
   });
   socket.on('poweroff', function () {
      log('turning off...');
      exec('sudo poweroff', (error, data) => {
         if(error && debug_ >= LogLevel.important)
            log({errorOnPoweroff: error, data});
      });
   });
});

function emitPeriodicData(socket)
{
   // todo
   // if(io.sockets.server.engine.clientsCount === 0)
   //    return;

   Promise.allSettled([executePythonScript('thermistor_with_a2d.py', toNumber), executePythonScript('photoresistor_with_a2d.py', toNumber), getPiHealthData()])
      .then(results => {
         if(debug_ >= LogLevel.verbose) log('Promise.allSettled sattled', results)
         
         let data = {
            thermistor: results[0].value || results[0].reason,
            photoresistor: results[1].value || results[1].reason,
            piHealthData: results[2].value || results[2].reason,
            photoresistorStatus: Object.entries(PhotoresistorValueStatuses).map(x => `${x[0]}: ${x[1]}`).join(', '),
            bulbControlMode: _values.bulbControlMode,
            bulbStatus: null,
            from: 'server',
            to: 'connectee',
            connectionCount: io.sockets.server.engine.clientsCount,
            localProxyStatus: _localProxyStatus,
            time: new Date().toLocaleString()
         }
         
         data.bulbStatus = data.photoresistor.success?
            controlBulb(data.photoresistor.value, _values.bulbControlMode, _values.bulbStatus) :
            _values.bulbStatus;
         if(data.bulbStatus !== _valeus.bulbStatus) {
            _values.bulbStatus = data.bulbStatus;
            fs.writeFileSync(valuesJsonPath, JSON.stringify(_values));
         }

         if(debug_ >= LogLevel.medium) log(data);

         socket.emit('periodic-data', data);
      })
      .catch(err => {
         if(debug_ >= LogLevel.important) log('emitSensorsData catch', err.toJsonString('emitSensorsData > catch'));
         
         socket.emit('periodic-data', { from: 'server', error: err.toJsonString('emitSensorsData > catch'), to: 'connectee' });
      });
}

function readHumiture() {
   return new Promise((resolve, reject) => {
      try {
         Humiture.read(11, 10, function(err, temperature, humidity) {
            if (!err) {
               // log(`temp: ${temperature}°C, humidity: ${humidity}%`)
               resolve({ temperature, humidity })
            }
            else {
               log({humitureReadError: err})
               reject(err)
            }
         });
      }
      catch (error) {
         if(debug_ >= LogLevel.important) log({humitureCatchError: error})
         reject(error)
      }
   });
}

function executePythonScript(codeFileName, parseCallback)
{
   if(debug_ >= LogLevel.verbose) log({ msg:'executePythonScript() entered', path: `${__dirname}/pythonScript/${codeFileName}` })
   
   const pyProg = spawn('python', [`${__dirname}/pythonScript/${codeFileName}`]);
   return new Promise((resolve, reject) => {
      try {
         if(debug_ >= LogLevel.verbose) log({msg: 'executePythonScript() -> in promise'})
         
         pyProg.stdout.on('data', function(data) {
            if(debug_ >= LogLevel.verbose) log({msg: 'executePythonScript() -> data', data})
            let result = {success: undefined}; 
            try {
               result.value = parseCallback ? parseCallback(data.toString()) : data.toString();
               result.success = true;
               resolve(result);
            }
            catch (error) {
               result.error = error.toJsonString('execute-python > on data event');
               result.success = false;
               reject(result);
            }
         });

         pyProg.stdout.on('error', function(err) {
            if(debug_ >= LogLevel.important) log({msg: 'pyProg.stdout.on > error', err});
            
            reject({error: err.toJsonString('execute-python > on error event'), succes: false});
         });
         pyProg.stdout.on('end', function(data){
            if(debug_ >= LogLevel.verbose) log({msg: 'pyProg.stdout.on > end', data});
            resolve({error: new Error('Data cannot be retreived from Python script.').toJsonString('execute-python > on end event'), success: false});
         });
      }
      catch(err) {
         log({execPythonError: err})
         reject({error: err, success: false})
      }
   });
}

function controlBulb(roomLightValue, bulbControlMode, bulbStatus)
{
   if(bulbControlMode === BulbControlModes.sensor) {
      const hour = new Date().getHours();
      // Set ON
      if(bulbStatus === OFF && 
         !hour.between(1, 6) && 
         roomLightValue >= PhotoresistorValueStatuses.LightDark)
      {
         bulbStatus  = ON;
         fs.writeFile(valuesJsonPath, JSON.stringify(_values), () => {});
      }
      // Set OFF
      // If the bulb is on checking the sensor will not help (because the room is lit).
      // Check the time instead
      else if(bulbStatus === ON && hour.between(1, 6))
      {
         bulbStatus  = OFF;
         fs.writeFile(valuesJsonPath, JSON.stringify(_values), () => {});
      }
   }

   // Set the state to PIN
   const pin = new Gpio(_optocoupler_pin, 'out');
   let val = pin.readSync();
   if(val !== bulbStatus)
      pin.writeSync(bulbStatus);

   return bulbStatus;
}

function getPiHealthData() {
   if(debug_ >= LogLevel.verbose) log('getPiHealthData() entered')
   return new Promise((resolve, reject) => {
      exec(`cat /proc/cpuinfo | grep Raspberry; echo "===Cpu temperature==="; cat /sys/class/thermal/thermal_zone0/temp; echo "===Gpu temperature==="; vcgencmd measure_temp; echo "===Memory Usage==="; free -h; echo "===Cpu Usage (top processes)==="; ps -eo command,pcpu,pmem,time --sort -pcpu | head -8; echo "===Voltage condition (expected: 0x0)==="; vcgencmd get_throttled; echo "===System Messages==="; dmesg | egrep 'voltage|error|fail';`,
         (error, data) => {
            if(debug_ >= LogLevel.verbose) log({msg: 'getPiHealthData() > exec > callback', error})
            if(error) {
               console.error({errorOnPiHealthData: error})
               reject({error: error.toJsonString('piHealthData'), succes: false})
            }      
            else {
               resolve({value: data, success: true});
            }
         });
   });
}

function startLocalhostProxy() {
   _localProxyStatus = 'Initializing...';
   let wait = 30 * 1000;

   if(debug_ >= LogLevel.verbose) log({_localProxyStatus});
   try {
      localtunnel({ subdomain: getSubdomain(_subdomainCounter), port: _port })
         .then(tunnel => {
            _localTunnelInstance = tunnel;
            _localProxyStatus = `Proxy resolved. [${tunnel.url}]`;

            if(debug_ >= LogLevel.important) log({_localProxyStatus});

            if(tunnel.url.startsWith(`https://${getSubdomain(_subdomainCounter)}.`) === false) {
               if(debug_ >= LogLevel.important) log({msg: `Didn't get the requested subdomain.`, _subdomainCounter, url: tunnel.url });
            
               // Multiple subdomains requested but didn't 
               // get the requested one. Try after some time.
               if(_subdomainCounter === 2) {
                  _subdomainCounter = 0;
                  // Try after 15 minutes
                  setTimeout(startLocalhostProxy, 15 * 60 * 1000);
                  return;
               }

               _subdomainCounter++;
               startLocalhostProxy(); // tunnel.close() doesn't always fire the 'close' event.
               return;
            }

            tunnel.on('close', () => {
               _localProxyStatus = `Closed. Initializing in ${wait} miliseconds.`;
               
               if(debug_ >= LogLevel.important) log({_localProxyStatus});

               setTimeout(() => startLocalhostProxy, wait); // restart the localtunnel after 30 seconds
            });
         })
         .catch(err => {
            _localProxyStatus = `Error on proxy resolve. [Error: ${err.toJsonString()}].`;
            if(debug_ >= LogLevel.important) log({_localProxyStatus});
         });
   }
   catch(err) {
      log({err, msg: `Handled exception on LocalTunnel. Reinitializing in ${wait} miliseconds.`});
      setTimeout(() => startLocalhostProxy, wait);
   }
}

function getSubdomain(counter) {
   return `${_subdomain}${counter ? counter : ''}`;
}

function log(...params) {
   console.log(`${new Date().toLocaleString()}\n`, params);
   // Log in file
   let fd;
   try {
      fd = fs.openSync(`${__dirname}/output/log-${new Date().toISOString().substring(0,10)}.txt`, 'a');
      fs.appendFileSync(fd, `${new Date().toLocaleString()}\n${JSON.stringify(params)}\n\n`, 'utf8');
    } 
    catch (err) {
      console.log('* Error on writing to log file.', err);
    }
    finally {
      if (fd !== undefined)
        fs.closeSync(fd);
    }
}

function toNumber(text) {
   let n = parseFloat(text);
   if(Number.isNaN(n))
      throw new Error('Not a number')
   else
      return n;
}

Error.prototype.toJsonString = function(inFunc) {
   this.inFunction = inFunc;
   return JSON.stringify(this, Object.getOwnPropertyNames(this));
}

Number.prototype.between = function(a, b) {
   return this >= a && this <= b;
}