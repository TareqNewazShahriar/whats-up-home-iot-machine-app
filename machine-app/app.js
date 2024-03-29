const { exec, spawn } = require('child_process');
const Gpio = require('onoff').Gpio; // Include onoff to interact with the GPIO pins
const { firestoreService, DB } = require('./firestoreService');
//const server = require('http').createServer(handleRequest);

const LogLevel = { none: 0, important: 1, medium: 2, verbose: 3 };
const LightConditions = { GoodLight: 180, MediumLight: 195, LightDark: 210, Dark: 216, VeryDark: 225, Blackhole: 255 };
const BulbControlModes = { sensor: 1, manual: 2 }
const _DebugLevel = LogLevel.important;
const _SensorMonitorInterval_AllDay = 5 * 60 * 1000;
const _SensorMonitorInterval_Midnight = 1 * 60 * 1000;
const ON = 1;
const OFF = Number(!ON);
const _Optocoupler_Pin = 16;
const _optocoupler_Gpio = new Gpio(_Optocoupler_Pin, 'out');
var _values = { bulbControlMode: BulbControlModes.manual, bulbState: OFF };
var _time_;

process.on('warning', error => log({ message: 'Node warning.', error: error.toJsonString()}));
process.on('SIGINT', () => {
   log({message: 'Node app exiting.'});
   process.exit();
});
process.on('uncaughtException', (error, origin) => {
   log({message: 'Uncaught exception.', error: error.message, call: error.stack, origin});
});
//server.listen(_port);
log({message: `Node app started. Getting this log in to DB and no listerner error mean PI is communicating with firebase.`});

// Handle response
// function handleRequest(req, res) {
//    res.write('Hello World!'); //write a response to the client
//    res.end(); //end the response
// }

firestoreService.getById(DB.Collections.values, 'user-settings')
   .then(data => _values = data)
   .catch(log);

firestoreService.attachListenerOnDocument(DB.Collections.values, 'machine-data-request', true, (data) => {
   if(data.success) {
      gatherMachineData()
         .then(clientData => firestoreService.update(DB.Collections.values, 'machine-data', clientData).catch(log))
         .catch(errorData => (_DebugLevel >= LogLevel.important ? log(errorData) : null));
   }
});

firestoreService.attachListenerOnDocument(DB.Collections.values, 'bulb-control-mode__from-client', true, function (data) {
   log({message: 'Bulb control mode switch requested.', data, _values});

   if(data.success) {
      _values.bulbControlMode = data.doc.value;
      firestoreService.update(DB.Collections.values, 'user-settings', _values)
         .catch(log);
   }
   else {
      log(data);
   }

   // Listener error or success, always communicate with the client.
   firestoreService.update(DB.Collections.values, 'bulb-control-mode__from-machine', { time: new Date() })
      .catch(log);
});

// Turn on/off the bulb from client
firestoreService.attachListenerOnDocument(DB.Collections.values, 'bulb-state__from-client', true, (data) => {
   log({message: 'Bulb state change requested.', data, _values});

   if(!data.success) {
      log(data);
      return;
   }

   if(_values.bulbControlMode !== BulbControlModes.manual)
      return;
   
   try {
      _values.bulbState = controlBulb(null, _values.bulbControlMode, data.doc.value, false, 'bulb-state__from-client');
      firestoreService.update(DB.Collections.values, 'user-settings', _values)
         .catch(log);
   }
   catch(error) {
      log({ message: 'Error while switching bulb pin.', error, _values, data});
   }

   firestoreService.update(DB.Collections.values, 'bulb-state__from-machine', { value: _values.bulbState, time: new Date() })
      .catch(log);
});

firestoreService.attachListenerOnDocument(DB.Collections.values, 'reboot__from-client', true, data => {
   log({ message: 'rebooting...'});
   exec('sudo reboot', (error, data) => {
      log({ message: 'Error on reboot', error, data});
   });
});

// This method shouldn't be called by anywhere else.
// Otherwise, this function will be registered to setTimeout multiple times.
(function monitorEnvironment()
{
   let isSleepTime = false;
   executePythonScript('photoresistor_with_a2d.py', toNumber)
      .then(data => {
         isSleepTime = isTimeToSleep(data.value);
         let newState = controlBulb(data.value, _values.bulbControlMode, _values.bulbState, isSleepTime, 'monitoring task');

         if(newState !== _values.bulbState) {
            _values.bulbState = newState;
            firestoreService.update(DB.Collections.values, 'user-settings', _values)
               .catch(log);
            firestoreService.update(DB.Collections.values, 'bulb-state__from-machine', { value: _values.bulbState, time: new Date() })
               .catch(log);
         }
      })
      .catch(data => log({message: 'Error while getting photoresistor data.', data}))
      .finally(() => setTimeout(monitorEnvironment, (isSleepTime ? _SensorMonitorInterval_Midnight : _SensorMonitorInterval_AllDay)));
})();

function gatherMachineData()
{
   return new Promise((resolve, reject) => {
      Promise.allSettled([executePythonScript('thermistor_with_a2d.py', toNumber), executePythonScript('photoresistor_with_a2d.py', toNumber), getPiHealthData()])
         .then(results => {
            if(_DebugLevel >= LogLevel.verbose) log({message: 'Promise.allSettled sattled', results})

            let data = {
               thermistor: results[0].value || results[0].reason,
               photoresistor: results[1].value || results[1].reason,
               piHealthData: results[2].value || results[2].reason,
               LightConditions,
               bulbControlMode: _values.bulbControlMode,
               bulbState: undefined,
               time: new Date(), // TODO: make utc using offset gmt
               node_pid: process.pid,
               node_parent_pid: process.ppid
            }
            
            data.bulbState = data.photoresistor.success?
               controlBulb(data.photoresistor.value, _values.bulbControlMode, _values.bulbState, false, 'getting machine data') :
               _values.bulbState;
            if(data.bulbState !== _values.bulbState) {
               _values.bulbState = data.bulbState;

               firestoreService.update(DB.Collections.values, 'user-settings', _values)
                  .catch(log);
            }

            if(_DebugLevel >= LogLevel.medium)
               log({message: `LogLevel:${_DebugLevel}`, data});

            resolve(data);
         })
         .catch(error => {
            reject({ message: 'gatherMachineData catch', error: error.toJsonString('gatherMachineData > catch')});
         });
   });
}

function executePythonScript(codeFileName, parseCallback)
{
   if(_DebugLevel >= LogLevel.verbose) log({ message:'executePythonScript entered', path: `${__dirname}/pythonScript/${codeFileName}` })

   return new Promise((resolve, reject) => {
      exec(`python ${__dirname}/pythonScript/${codeFileName}`, (error, data) => {
            if(_DebugLevel >= LogLevel.verbose) log({message: 'executePythonScript -> in promise'});

            if(error) {
               if(_DebugLevel >= LogLevel.important) log({message: 'executePythonScript > error', error});
               
               reject({error: error.toJsonString('execute-python > on error event'), succes: false});
            }
            else {
               if(_DebugLevel >= LogLevel.verbose) log({message: 'executePythonScript -> success', data});
         
               let result = {}; 
               try {
                  result.value = parseCallback ? parseCallback(data.toString()) : data.toString();
                  result.success = true;
                  resolve(result);
               }
               catch (error) {
                  result.error = error.toJsonString('execute-python > data > try-catch');
                  result.success = false;
                  reject(result);
               }
            }
         });//exec
      });//promise
}

function executePythonScriptUsingSpawn(codeFileName, parseCallback) {
   if(_DebugLevel >= LogLevel.verbose)
      log({ message:'executePythonScriptUsingSpawn() entered', path: `${__dirname}/pythonScript/${codeFileName}` })

   const pyProg = spawn('python', [`${__dirname}/pythonScript/${codeFileName}`]);
   return new Promise((resolve, reject) => {
      if(_DebugLevel >= LogLevel.verbose) log({message: 'executePythonScriptUsingSpawn() -> in promise'})

      pyProg.stdout.on('data', function(data) {
         if(_DebugLevel >= LogLevel.verbose) log({message: 'executePythonScriptUsingSpawn() -> data', data});

         let result = {};
         try {
            result.value = parseCallback ? parseCallback(data.toString()) : data.toString();
            result.success = true;
            resolve(result);
         }
         catch (error) {
            result.error = error.toJsonString('spawn-python > data > try-catch');
            result.success = false;
            reject(result);
         }
      });

      pyProg.stdout.on('error', function(err){
         log({message: 'pyProg.stdout.on > error', err});
         reject({ success: false, message: `Error occurred while executing python script: ${codeFileName}. [${err.message}]`, error: err });
      });

      pyProg.stdout.on('end', function(data){
         // Promise should be resolved (resolve or reject) should be 
         // called earlier this event.
         // Not resolving the promise this far means someting's wrong.
         // So execute the reject callback.

         if(_DebugLevel >= LogLevel.verbose) log({message: 'pyProg.stdout.on > end', data});
         reject({ success: false, message: `From spawn>end event, script: ${codeFileName}` });
      });
   });
}

function getPiHealthData() {
   if(_DebugLevel >= LogLevel.verbose) log({ message: 'getPiHealthData() entered'})
   return new Promise((resolve, reject) => {
      exec(`cat /proc/cpuinfo | grep Raspberry; echo "\n ----- Cpu temperature -----";  /usr/bin/vcgencmd measure_temp | awk -F "[=']" '{print($2, "C")}'; echo "\n ----- Gpu temperature -----"; vcgencmd measure_temp | egrep -o '[[:digit:]].*'; echo "\n ----- Memory Usage -----"; free -h; echo "\n ----- Cpu Usage (top processes) -----"; ps -eo time,pmem,pcpu,command --sort -pcpu | head -8; echo "\n ----- Voltage condition (expected: 0x0) -----"; vcgencmd get_throttled; echo "\n ----- Critical system messages -----"; dmesg | egrep 'voltage|error|fail' | cat;`,
         (error, data) => {
            if(_DebugLevel >= LogLevel.verbose) log({message: 'getPiHealthData() > exec > callback', error})
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

function controlBulb(roomLightValue, bulbControlMode, bulbState, toggleBulb, from) {
   if(toggleBulb) {
      bulbState = Number(!_optocoupler_Gpio.readSync());
      log({message: 'Going to toggle the bulb.', bulbState, bulbControlMode, roomLightValue, from});
   }
   else if(bulbControlMode === BulbControlModes.sensor) {
      let currentTime = new Date();
      let evening = new Date();
      let midnight = new Date();
      let nextMorning = new Date();
      
      evening.setHours(18); // 6:?? pm
      evening.setMinutes(0); // 6:00 pm
      
      midnight.setHours(23); // 10:?? pm
      midnight.setMinutes(0); // 10:30 pm
      
      nextMorning.setDate(nextMorning.getDate() + 1);
      nextMorning.setHours(6) // 6:?? am
      nextMorning.setMinutes(0); // 6:00 am

      // Set ON
      if(
         bulbState === OFF &&
         (
            currentTime.between(evening, midnight) 
            ||
            (
               roomLightValue >= LightConditions.LightDark &&
               !currentTime.between(midnight, nextMorning)
            )
         )
      )
      {
         bulbState = ON;
         
         if(_DebugLevel >= LogLevel.important)
            log({message: 'Going to switch bulb state.', bulbState, bulbControlMode, roomLightValue, currentTime, evening, midnight, nextMorning, from});
      }
      // Set OFF
      // NOTE: If the bulb is on checking the sensor will not help (because the room is lit). Check the time instead.
      else if(
         bulbState === ON &&
         (
            currentTime.between(midnight, nextMorning)/*midnight*/
            ||
            (
               roomLightValue < LightConditions.LightDark && 
               !currentTime.between(evening, midnight)
            )
         )
      )
      {
         bulbState = OFF;

         if(_DebugLevel >= LogLevel.important)
            log({message: 'Going to switch bulb state.', bulbState, bulbControlMode, roomLightValue, currentTime, evening, midnight, nextMorning, from});
      }
   }

   // Set the state to PIN
   _optocoupler_Gpio.writeSync(bulbState);

   // whatever the request state is, return the actual state of the bulb.
   let val = _optocoupler_Gpio.readSync();
   if(_DebugLevel >= LogLevel.important && val != bulbState)
      log({message: 'RPi pin state update failed.', currentState: val, requested: bulbState, from});

   return val;
}

function isTimeToSleep(lightConditionValue) {
   return lightConditionValue < LightConditions.Dark && [23, 0, 1].includes(new Date().getHours());
}

function log(logData) {
   logData.node_pid = process.pid;
   logData.node_parent_pid = process.ppid;
   _time_ = new Date();
   _time_.setMinutes(_time_.getMinutes() - _time_.getTimezoneOffset()); // convert to local time for easier auditing.

   console.log(`${_time_.toJSON()}\n`, logData);
   firestoreService.create(DB.Collections.logs, logData, _time_.toJSON())
      .catch(console.log);
}

function toNumber(text) {
   let n = parseFloat(text);
   if(Number.isNaN(n))
      throw new Error('Not a number');
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

Date.prototype.between = function(a, b) {
   return this >= a && this <= b;
}
