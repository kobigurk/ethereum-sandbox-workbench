/*
 * Ethereum Sandbox Helper
 * Copyright (C) 2016  <ether.camp> ALL RIGHTS RESERVED  (http://ether.camp)
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License version 3
 * as published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License version 3 for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

var Module = require('module');
var vm = require('vm');
Promise.prototype['originalThen'] = Promise.prototype.then;
Promise.prototype['then'] = function() {
  var resultCheckerFunc = function(result) {
    if (typeof result === 'undefined')
      console.log("WARNING: result from promise was undefined");
    return result;
  };
  if (typeof arguments[1] === 'function') {
    return this.originalThen(arguments[0], arguments[1]);
  } else {
    return this.originalThen(arguments[0])
    .originalThen(resultCheckerFunc);
  }
};
var Pudding = require('ether-pudding');
var requireFromSourceInject =  function(source, filename) {
  // Modified from here: https://gist.github.com/anatoliychakkaev/1599423
  // Allows us to require asynchronously while allowing specific dependencies.
  var m = new Module(filename);

  // Provide all the globals listed here: https://nodejs.org/api/globals.html
  var context = {
    Buffer: Buffer,
    __dirname: path.dirname(filename),
    __filename: filename,
    clearImmediate: clearImmediate,
    clearInterval: clearInterval,
    clearTimeout: clearTimeout,
    Promise: Promise,
    console: console,
    exports: exports,
    global: global,
    module: m,
    process: process,
    require: require,
    setImmediate: setImmediate,
    setInterval: setInterval,
    setTimeout: setTimeout,
  };

  var script = vm.createScript(source, filename);
  script.runInNewContext(context);

  return m.exports;
};

Pudding._requireFromSource = requireFromSourceInject;

var path = require('path');
var fs = require('fs');

var callsite = require('callsite');
var Sandbox = require('ethereum-sandbox-client');
var helper = require('ethereum-sandbox-helper');
var SolidityFunction = require("web3/lib/web3/function.js");
var coder = require('web3/lib/solidity/coder');

var proxyContractName = 'Proxy';

function configureState(options, ethereumJsonPath) {
  var state;
  if (options.initialState) {
    state = {
      contracts: 'contracts',
      env: options.initialState
    };
    fs.writeFileSync(ethereumJsonPath, JSON.stringify(state));
  }

  if (!fs.existsSync(ethereumJsonPath)) {
    var defaultAccount = '0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826';
    if (options.defaults && options.defaults.from) defaultAccount = options.defaults.from;
    state = {
      contracts: 'contracts',
      env: {
        block: {
          coinbase: defaultAccount,
          difficulty: '0x0100',
          gasLimit: 314159200,
          gasPrice: 600000000
        },
        accounts: {}
      }
    };
    state.env.accounts[defaultAccount] = {
      name: 'fellow-1',
      balance: 1000000000000000000000000,
      nonce: '1430',
      pkey: 'cow',
      default: true
    };
    fs.writeFileSync(ethereumJsonPath, JSON.stringify(state));
  }
}

var Workbench = function(options) {
  this.sandbox = new Sandbox('http://localhost:8554');
  this.readyContracts = {};
  if (!options) options = {};
  this.defaults = options.defaults;
  this.contractsDirectory = options.contratcsDirectory;
  this.ethereumJsonPath = path.dirname(callsite()[1].getFileName()) + '/ethereum.json';
  if (options.ethereumJsonPath) this.ethereumJsonPath = options.ethereumJsonPath;
  configureState(options, this.ethereumJsonPath);
};

Workbench.prototype.compile = function(contracts, dir, cb) {
  var output = helper.compile(dir, contracts);
  var proxyOutput = helper.compile(__dirname, [proxyContractName + '.sol']);
  Object.assign(output.contracts, proxyOutput.contracts);
  Object.assign(output.sources, proxyOutput.sources);
  var ready = {};
  Object.keys(output.contracts).forEach(contractName => {
    var contract = output.contracts[contractName];
    var contractData = {
      abi: JSON.parse(contract.interface),
      unlinked_binary: '0x' + contract.bytecode
    };
    ready[contractName] = Pudding.whisk(contractName, contractData);
  });
  if (cb) cb(ready);
  return ready;
};

Workbench.prototype.start = function(contracts, cb) {
  var self = this;
  this.sandbox.start(this.ethereumJsonPath, function (err) {
    if (err) return cb(err);
    Object.keys(contracts).forEach(contractName => {
      contracts[contractName].setProvider(self.sandbox.web3.currentProvider);
      if (self.defaults) contracts[contractName].defaults(self.defaults);
    });
    cb();
  });
};

Workbench.prototype.stop = function(cb) {
  this.sandbox.stop(cb);
};

function makeCallsSync(contract) {
  var self = this;
  contract.originalNew = contract.new;
  contract.new = function() {
    return this.originalNew.apply(this, arguments)
    .then(function(contractToPatch) {
      contractToPatch.web3Contract = self.sandbox.web3.eth.contract(contractToPatch.abi).at(contractToPatch.address);
      contractToPatch.abi.forEach(obj => {
        if (obj.type === 'function') {
          var callFunc = function() {
            var options = {};
            Object.assign(options, self.defaults);
            var args = arguments;
            args[Object.keys(args).length] = options;
            return contractToPatch.web3Contract[obj.name].call.apply(null, args);
          };
          var newFunc;
          if (obj.constant) {
            newFunc = callFunc; 
            Object.assign(newFunc, contractToPatch[obj.name]);
          } else {
            newFunc = contractToPatch[obj.name];
          }
          newFunc.call = callFunc;
          contractToPatch[obj.name] = newFunc;
        }
      });
      return contractToPatch;
    });
  };
};

function setupMockOnContract(contract) {
  var self = this;
  contract.newMock = function(options) {
    return self.readyContracts[proxyContractName].originalNew((options && options.traceFunctionCalls) || false)
    .then(function(proxyContract) {
      if (proxyContract.address) {
        var proxyContractMock = contract.at(proxyContract.address);
        proxyContractMock.abi.forEach(obj => {
          if (obj.type === 'function') {
            var func = new SolidityFunction(null, obj, null);
            proxyContractMock[obj.name].mockCallReturnValue = function(returnValue, onArgs) {
              var encoded = coder.encodeParams([obj.outputs[0].type], [returnValue]);
              var promise;
              if (onArgs) {
                var encodedInput = coder.encodeParams(obj.inputs.map(x => x.type), onArgs);
                promise = proxyContract.setMockWithArgs('0x' + func.signature() + encodedInput, 2, '0x0', '0x' + encoded, {gas: 500000})
              } else {
                promise = proxyContract.setMock('0x' + func.signature(), 2, '0x0', '0x' + encoded, {gas: 500000})
              }
              return promise
              .then(function(txHash) {
                return self.waitForReceipt(txHash);
              });
            };
            proxyContractMock[obj.name].mockTransactionForward = function(address, options, onArgs) {
              var data;
              if (options.data) {
                data = options.data;
              } else {
                var funcAbi;
                options.contract.abi.forEach(abiFunc => {
                  if (options.functionName === abiFunc.name) {
                    funcAbi = abiFunc;
                  }
                });
                var funcForForward = new SolidityFunction(null, funcAbi, null);
                data = funcForForward.toPayload(options.args).data;
              }
              var promise;
              if (onArgs) {
                var encodedInput = coder.encodeParams(obj.inputs.map(x => x.type), onArgs);
                promise = proxyContract.setMockWithArgs('0x' + func.signature() + encodedInput, 1, address, data, {gas: 500000})
              } else {
                promise = proxyContract.setMock('0x' + func.signature(), 1, address, data, {gas: 500000})
              }

              return promise
              .then(function(txHash) {
                return self.waitForReceipt(txHash);
              });
            };

            proxyContractMock[obj.name].wasCalled = function(receipt) {
              var called = false;
              var retArgs;
              receipt.logs.forEach(eventLog => {
                if (eventLog.parsed && eventLog.parsed.event == 'Trace') {
                  var funcSig = '0x' + func.signature();
                  var parsedArgs = eventLog.parsed.args;
                  if (parsedArgs.data.startsWith(funcSig)) {
                    called = true;
                    retArgs = coder.decodeParams(obj.inputs.map(x => x.type), parsedArgs.data.replace(funcSig, ''));
                  }
                }
              });
              return {
                called: called,
                args: retArgs
              };
            };
          }
        });
        return proxyContractMock;
      } else {
        throw new Error('No address for proxy contract');
      }
    });
  };
};

Workbench.prototype.startTesting = function(contracts, cb) {
  var self = this;

  if (typeof contracts === 'string') contracts = [contracts];
  contracts = contracts.map(x => x + '.sol');
  var dir = this.contractsDirectory;
  if (!dir) dir = './contract';

  this.readyContracts = this.compile(contracts, dir);
  Object.keys(this.readyContracts).forEach(contractName => {
    var contract = this.readyContracts[contractName];
    makeCallsSync.bind(this)(contract);
    setupMockOnContract.bind(this)(contract);
  });

  var name = '[' + contracts.join(', ') + '] Contracts Testing';
  describe(name, function() {
    this.timeout(60000);
    before(function(done) {
      self.start(self.readyContracts, done);
    });
    after(function(done) {
      self.stop(done);
    });
    if (cb) cb(self.readyContracts);
  });
};

Workbench.prototype.waitForReceipt = function (txHash) {
  var self = this;
  return new Promise((resolve, reject) => {
    helper.waitForReceipt(self.sandbox.web3, txHash, function (err, receipt) {
      if (err) return reject(err);
      receipt.logs.forEach(eventLog => {
        for (var key in self.readyContracts) {
          eventLog.parsed = helper.parseEventLog(self.readyContracts[key].abi, eventLog);
          if (eventLog.parsed) break;
        }
      });
      return resolve(receipt);
    });
  });
};

Workbench.prototype.waitForSandboxReceipt = function (txHash) {
  var self = this;
  return new Promise((resolve, reject) => {
    helper.waitForSandboxReceipt(self.sandbox.web3, txHash, function (err, receipt) {
      if (err) return reject(err);
      return resolve(receipt);
    });
  });
};

Workbench.prototype.sendTransaction = function (options) {
  var self = this;
  return new Promise((resolve, reject) => {
    return self.sandbox.web3.eth.sendTransaction(options, function (err, txHash) {
      if (err) return reject(err);
      return resolve(txHash);
    });
  });
};

Workbench.prototype.call = function (options) {
  var self = this;
  return new Promise((resolve, reject) => {
    return self.sandbox.web3.eth.call(options, function (err, result) {
      if (err) return reject(err);
      return resolve(result);
    });
  });
};

module.exports = Workbench;
