const Web3 = require("web3");
const _ = require("lodash");
const AbiStorage = require("./utils/abiStorage");

class BatchCall {
  constructor(config) {
    const {
      web3,
      provider,
      groupByNamespace,
      logging,
      simplifyResponse,
      store,
    } = config;

    if (typeof web3 === "undefined" && typeof provider === "undefined") {
      throw new Error(
        "You need to either provide a web3 instance or a provider string ser!"
      );
    }

    if (web3) {
      this.web3 = web3;
    } else {
      this.web3 = new Web3(provider);
    }

    const { etherscan = {} } = config;
    const { apiKey: etherscanApiKey = null, delayTime = 300 } = etherscan;

    this.etherscanApiKey = etherscanApiKey;
    this.etherscanDelayTime = delayTime;
    this.abiHashByAddress = {};
    this.abiByHash = {};
    this.groupByNamespace = groupByNamespace;
    this.logging = logging;
    this.simplifyResponse = simplifyResponse;
    this.readContracts = {};
    this.store = new AbiStorage({
      store,
      etherscanApiKey,
      logging,
    });
  }

  async execute(contractsBatch, blockNumber) {
    const startTime = Date.now();
    let numberOfMethods = 0;
    const { web3 } = this;
    const addContractToBatch = async (batch, contractConfig) => {
      const {
        addresses,
        contracts,
        namespace = "default",
        readMethods = [],
        allReadMethods,
      } = contractConfig;
      const objectToIterateOver = addresses || contracts;
      const addressPromises = await objectToIterateOver.map(
        addAddressToBatch.bind(
          null,
          batch,
          readMethods,
          allReadMethods,
          namespace
        )
      );
      return await Promise.all(addressPromises);
    };

    const addAddressToBatch = async (
      batch,
      readMethods,
      allReadMethods,
      namespace,
      item
    ) => {
      const itemIsContract = item.options;
      let address;
      let abi;
      if (itemIsContract) {
        address = item.options.address;
        abi = item.options.jsonInterface;
      } else {
        address = item;
        abi = this.store.getAbiFromCache(address);
      }

      const contract = new web3.eth.Contract(abi, address);

      let allMethods = _.clone(readMethods);
      if (allReadMethods) {
        const formatField = (name) => ({ name });
        const allFields = this.store
          .getReadableAbiFields(address)
          .map(formatField);
        allMethods.push(...allFields);
      }

      const filterOutConstants = (method) => {
        const readContractAtLeastOnce = this.readContracts[address];
        const { constant } = method;
        if (constant && readContractAtLeastOnce) {
          return false;
        }
        return true;
      };
      allMethods = _.filter(allMethods, filterOutConstants);

      const methodsPromises = await allMethods.map(
        addMethodToBatch.bind(null, batch, contract, abi, address)
      );
      const methodsState = await Promise.all(methodsPromises);
      this.readContracts[address] = true;
      return Promise.resolve({
        address,
        namespace,
        state: methodsState,
      });
    };

    const addMethodToBatch = (batch, contract, abi, address, method) =>
      new Promise((methodResolve, methodReject) => {
        const { name, args } = method;
        let methodCall;
        const methodExists = _.get(contract.methods, name);
        if (!methodExists) {
          return methodResolve();
        }
        if (args) {
          methodCall = contract.methods[name](...args).call;
        } else {
          methodCall = contract.methods[name]().call;
        }
        numberOfMethods += 1;
        const returnResponse = (err, data) => {
          if (err) {
            methodReject(err);
          } else {
            const abiMethod = _.find(abi, { name });
            const input =
              args && web3.eth.abi.encodeFunctionCall(abiMethod, args);
            methodResolve({
              method: method.name,
              value: data,
              input,
              args,
            });
          }
        };
        let req;
        if (blockNumber) {
          req = methodCall.request(blockNumber, returnResponse);
        } else {
          req = methodCall.request(returnResponse);
        }
        batch.add(req);
      });

    const formatContractsState = (acc, contractConfig) => {
      const addMethodResults = (address, namespace, result) => {
        if (!result) {
          return acc;
        }
        const { method, value, input, args } = result;
        const addressResult = _.find(acc, { address }) || {};
        const foundAddressResult = _.size(addressResult);
        const methodArgs = _.get(addressResult, method, []);
        const existingMethodInput = _.find(methodArgs, { input });
        const methodArg = {
          value,
          input,
          args,
        };
        if (!input) {
          delete methodArg.input;
        }
        if (!args) {
          delete methodArg.args;
        }
        if (!existingMethodInput && foundAddressResult) {
          methodArgs.push(methodArg);
          addressResult[method] = methodArgs;
        }
        if (!input && foundAddressResult) {
          addressResult[method] = [methodArg];
        }
        if (!foundAddressResult) {
          const newAddressResult = {
            address,
            namespace,
          };
          newAddressResult[method] = [methodArg];
          acc.push(newAddressResult);
        }
      };
      const addAddressCalls = (addressCall) => {
        const { address, state, namespace } = addressCall;
        _.each(state, addMethodResults.bind(null, address, namespace));
      };
      _.each(contractConfig, addAddressCalls);
      return acc;
    };

    const addAbis = async (contractBatch) => {
      const { abi, addresses } = contractBatch;
      for (const address of addresses) {
        await this.store.addAbiToCache(address, abi);
      }
    };
    for (const contractBatch of contractsBatch) {
      const { contracts } = contractBatch;
      if (!contracts) {
        await addAbis(contractBatch);
      }
    }

    const batch = new web3.BatchRequest();
    const contractsPromises = contractsBatch.map(
      addContractToBatch.bind(null, batch)
    );

    let contractsState;
    batch.execute();
    try {
      const contractsPromiseResult = await Promise.all(contractsPromises);
      contractsState = _.reduce(
        contractsPromiseResult,
        formatContractsState,
        []
      );
    } catch (err) {
      return { error: err.message };
    }

    let contractsToReturn = contractsState;

    if (this.simplifyResponse) {
      const flattenArgs = (contract) => {
        const flattenArg = (val, key) => {
          const flattenedVal = val[0].value;
          if (flattenedVal) {
            contract[key] = flattenedVal;
          }
        };
        _.each(contract, flattenArg);
        return contract;
      };
      contractsToReturn = _.map(contractsToReturn, flattenArgs);
    }

    if (this.groupByNamespace) {
      const contractsStateByNamespace = _.groupBy(contractsState, "namespace");

      const removeNamespaceKey = (acc, contracts, key) => {
        const omitNamespace = (contract) => _.omit(contract, "namespace");
        acc[key] = _.map(contracts, omitNamespace);
        return acc;
      };

      const contractsStateByNamespaceReduced = _.reduce(
        contractsStateByNamespace,
        removeNamespaceKey,
        {}
      );
      contractsToReturn = contractsStateByNamespaceReduced;
    }
    if (this.logging) {
      const endTime = Date.now();
      const executionTime = endTime - startTime;
      console.log(
        `[BatchCall] methods: ${numberOfMethods}, execution time: ${executionTime} ms`
      );
    }
    return contractsToReturn;
  }
}

module.exports = BatchCall;
