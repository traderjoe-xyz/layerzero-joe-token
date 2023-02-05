import * as crossChainHelper from "./utils/crossChainHelper"
import { Transaction } from "./utils/crossChainHelper"
import {CHAIN_STAGE, ChainKey, ChainStage} from "@layerzerolabs/lz-sdk"
import WIRE_UP_CONFIG from "../constants/wireUpConfig.json"
import ENDPOINTS from "../constants/layerzeroEndpoints.json"
import ABI from "../constants/endpoint_abi.json"
import {ethers} from "ethers"
import {arrayToCsv} from "./utils/utils";
import path from "path";
import YAML from "yaml";
import { CHAIN_ID } from '@layerzerolabs/lz-sdk'
const fsPromises = require("fs").promises
const fs = require("fs")

module.exports = async function (taskArgs, hre) {
    console.log(taskArgs)
    const signers = await hre.ethers.getSigners()
    console.log(`CURRENT SIGNER: ${signers[0].address}`)
    const localNetworks = taskArgs.s.split(",")
    const remoteNetworks = taskArgs.d.split(",")
    // remoteNetworks.push(...taskArgs.nonEvms !== undefined ? taskArgs.nonEvms.split(",") : [])
    const env = taskArgs.e

    let stage;
    if (env === "mainnet") {
        stage = ChainStage.MAINNET
    } else if (env === "testnet") {
        stage = ChainStage.TESTNET
    } else {
        console.log("Invalid environment ie: mainnet, testnet")
        return
    }

    validateStageOfNetworks(stage, localNetworks, remoteNetworks)

    // prompt for continuation
    await crossChainHelper.promptToProceed(
        `do you want to wire these localNetworks: ${localNetworks} and remoteNetworks: ${remoteNetworks}?`,
        taskArgs.noPrompt
    )

    console.log(`************************************************`)
    console.log(`Computing diff`)
    console.log(`************************************************`)
    let lockDown = true;
    let transactionBynetwork = await Promise.all(
        localNetworks.map(async (localNetwork) => {
            const transactions: crossChainHelper.Transaction[] = []
            let localContractName
            if(WIRE_UP_CONFIG["proxyChain"][env] === localNetwork) {
                localContractName = WIRE_UP_CONFIG["proxyContractName"][env];
            }
            localContractName = localContractName === undefined ? WIRE_UP_CONFIG["contractName"][env] : localContractName;
            transactions.push(...(await setUseCustomAdapterParams(hre, localNetwork, localContractName, WIRE_UP_CONFIG[localNetwork].useCustomAdapterParams)))
            transactions.push(...(await lockToSendAndRecvVersion(hre, localNetwork, localContractName, {sendVersion: WIRE_UP_CONFIG[localNetwork].sendVersion, receiveVersion: WIRE_UP_CONFIG[localNetwork].receiveVersion, lockDown})))
            if(WIRE_UP_CONFIG[localNetwork].setDefault) {
                transactions.push(...(await setDefaultFeeBp(hre, localNetwork, localContractName, WIRE_UP_CONFIG[localNetwork].defaultFeeBp)))
            }
            await Promise.all(remoteNetworks.map(async (remoteNetwork) => {
                if(localNetwork === remoteNetwork) return
                let remoteContractName;
                if(WIRE_UP_CONFIG["proxyChain"][env] === remoteNetwork) {
                    remoteContractName = WIRE_UP_CONFIG["proxyContractName"][env]
                }
                remoteContractName = remoteContractName === undefined ? WIRE_UP_CONFIG["contractName"][env] : remoteContractName;

                transactions.push(...(await setInboundProofType(hre, localNetwork, localContractName, CHAIN_ID[remoteNetwork], WIRE_UP_CONFIG[remoteNetwork].inBoundProofType, lockDown)))
                transactions.push(...(await setInboundBlockConfirmations(hre, localNetwork, localContractName, CHAIN_ID[remoteNetwork], WIRE_UP_CONFIG[remoteNetwork].inBoundBlockConfirmations, lockDown)))
                transactions.push(...(await setRelayer(hre, localNetwork, localContractName, CHAIN_ID[remoteNetwork], WIRE_UP_CONFIG[localNetwork].relayerAddress, lockDown)))
                transactions.push(...(await setOutboundProofType(hre, localNetwork, localContractName, CHAIN_ID[remoteNetwork], WIRE_UP_CONFIG[localNetwork].outBoundProofType, lockDown)))
                transactions.push(...(await setOutboundBlockConfirmations(hre, localNetwork, localContractName, CHAIN_ID[remoteNetwork], WIRE_UP_CONFIG[localNetwork].outBoundBlockConfirmations, lockDown)))
                transactions.push(...(await setOracle(hre, localNetwork, localContractName, CHAIN_ID[remoteNetwork], WIRE_UP_CONFIG[localNetwork].oracleAddress)))
                transactions.push(...(await setTrustedRemote(hre, localNetwork, localContractName, remoteNetwork, remoteContractName, taskArgs.e)))
                transactions.push(...(await setMinDstGas(hre, localNetwork, localContractName, WIRE_UP_CONFIG[localNetwork]["remoteNetworkConfigs"][remoteNetwork].minDstGasConfig, CHAIN_ID[remoteNetwork])))
                if(!WIRE_UP_CONFIG[localNetwork].setDefault) {
                    transactions.push(...(await setFeeBp(hre, localNetwork, localContractName, WIRE_UP_CONFIG[localNetwork]["remoteNetworkConfigs"][remoteNetwork].feeBpConfig, CHAIN_ID[remoteNetwork])))
                }
            }))
            return {
                network: localNetwork,
                transactions,
            }
        })
    )

    const noChanges = transactionBynetwork.reduce((acc, { transactions }) => {
        acc += transactions.filter((transaction) => transaction.needChange).length
        return acc
    }, 0)
    if (noChanges == 0) {
        //early return
        console.log("No changes needed")
        return
    }

    transactionBynetwork.forEach(({ network, transactions }) => {
        console.log(`************************************************`)
        console.log(`Transaction for ${network}`)
        console.log(`************************************************`)
        const transactionNeedingChange = transactions.filter((transaction) => transaction.needChange)
        if (!transactionNeedingChange.length) {
            console.log("No change needed")
        } else {
            console.table(transactionNeedingChange)
        }
    })

    const columns = ["needChange", "chainId", "remoteChainId", "contractName", "methodName", "args", "diff", "calldata"]

    const data = transactionBynetwork.reduce((acc, { network, transactions }) => {
        transactions.forEach((transaction) => {
            acc.push([
                network,
                ...columns.map((key) => {
                    if (typeof transaction[key] === "object") {
                        return JSON.stringify(transaction[key])
                    } else {
                        return transaction[key]
                    }
                }),
            ])
        })
        return acc
    }, [])
    await fsPromises.writeFile("./transactions.csv", arrayToCsv(["network"].concat(columns), data))

    console.log("Full configuration is written at:")
    console.log(`file:/${process.cwd()}/transactions.csv`)

    const errs: any[] = []
    const print: any = {}
    let previousPrintLine = 0
    const printResult = () => {
        if (previousPrintLine) {
            process.stdout.moveCursor(0, -previousPrintLine)
        }
        if (Object.keys(print)) {
            previousPrintLine = Object.keys(print).length + 4
            console.table(Object.keys(print).map((network) => ({ network, ...print[network] })))
        }
    }

    if (taskArgs.n) {
        await crossChainHelper.promptToProceed("Would you like to Submit to gnosis?", taskArgs.noPrompt)
        await Promise.all(
            transactionBynetwork.map(async ({ network, transactions }) => {
                const transactionToCommit = transactions.filter((transaction) => transaction.needChange)

                print[network] = print[network] || { requests: `1/1` }
                print[network].current = `executeGnosisTransactions: ${transactionToCommit}`
                try {
                    await crossChainHelper.executeGnosisTransactions(hre, network, transactionToCommit)
                    print[network].requests = `1/1`
                    printResult()
                } catch (err: any) {
                    console.log(`Failing calling executeGnosisTransactions for network ${network} with err ${err}`)
                    errs.push({
                        network,
                        err,
                    })
                    print[network].current = err.message
                    print[network].err = true
                    printResult()
                }
            })
        )
    } else {
        await crossChainHelper.promptToProceed("Would you like to run these transactions?", taskArgs.noPrompt)
        await Promise.all(
            transactionBynetwork.map(async ({ network, transactions }) => {
                const transactionToCommit = transactions.filter((transaction) => transaction.needChange)

                let successTx = 0
                print[network] = print[network] || { requests: `${successTx}/${transactionToCommit.length}` }
                for (let transaction of transactionToCommit) {
                    print[network].current = `${transaction.contractName}.${transaction.methodName}`
                    printResult()
                    try {
                        const tx = await crossChainHelper.executeTransaction(hre, network, transaction)
                        print[network].past = `${transaction.contractName}.${transaction.methodName} (${tx.transactionHash})`
                        successTx++
                        print[network].requests = `${successTx}/${transactionToCommit.length}`
                        printResult()
                    } catch (err: any) {
                        console.log(`Failing calling ${transaction.contractName}.${transaction.methodName} for network ${network} with err ${err}`)
                        console.log(err)
                        errs.push({
                            network,
                            err,
                        })
                        print[network].current = err
                        print[network].err = true
                        printResult()
                        break
                    }
                }
            })
        )
    }

    if (!errs.length) {
        console.log("Wired all networks successfully")
    } else {
        console.log(errs)
    }
}

// encode the calldata into the 'calldata' the transaction requires to be sent
// hre: the hardhat runtime environment, for access to hre.web3.utils.keccak256()
// methodName: "setPause" or "setRemoteUln"  ie: the string name of the contract function
// params: ['bool','uint256'] ie: a string array of the types of the function parameters
// args: [ true, 1234 ] ie: the array of values that correspond to the types in params
//
// return: string like: "0xbedb86fb0000000000000000000000000000000000000000000000000000000000000001"
export function generateCalldata(hre: any, methodName: string, params: string[], args: any) {
    return `${hre.web3.utils.keccak256(`${methodName}(${params.join(",")})`).substring(0, 10)}${hre.web3.eth.abi
        .encodeParameters(params, args)
        .substring(2)}`
}

async function setUseCustomAdapterParams(hre: any, localNetwork: string, localContractName: string, useCustom: boolean): Promise<Transaction[]> {
    const localContract = await crossChainHelper.getContract(hre, localNetwork, localContractName)
    const cur = await localContract.useCustomAdapterParams()
    const needChange = cur !== useCustom

    // function setUseCustomAdapterParams(bool _useCustomAdapterParams)
    const methodName = "setUseCustomAdapterParams"
    const params = ['bool']
    let args = [useCustom]

    const tx: any = {
        needChange,
        chainId: crossChainHelper.getEndpointId(localNetwork),
        contractName: localContractName,
        methodName: methodName,
        args: args,
        calldata: generateCalldata(hre, methodName, params, args),
    }
    if (tx.needChange) {
        tx.diff = JSON.stringify({ useCustomAdapterParams: { oldValue: cur, newValue: useCustom } });
    }
    return [tx]
}

async function setDefaultFeeBp(hre: any, localNetwork: string, localContractName: string, defaultFeeBp: number): Promise<Transaction[]> {
    const localContract = await crossChainHelper.getContract(hre, localNetwork, localContractName)
    const cur = await localContract.defaultFeeBp()
    const needChange = cur !== defaultFeeBp

    // function setDefaultFeeBp(uint16 _feeBp)
    const methodName = "setDefaultFeeBp"
    const params = ['uint16']
    let args = [defaultFeeBp]

    const tx: any = {
        needChange,
        chainId: crossChainHelper.getEndpointId(localNetwork),
        contractName: localContractName,
        methodName: methodName,
        args: args,
        calldata: generateCalldata(hre, methodName, params, args),
    }
    if (tx.needChange) {
        tx.diff = JSON.stringify({ defaultFeeBp: { oldValue: cur, newValue: defaultFeeBp } })
    }
    return [tx]
}

async function setFeeBp(hre: any, localNetwork: string, localContractName: string, feeBpConfig: any, remoteChainId: number): Promise<Transaction[]> {
    const localContract = await crossChainHelper.getContract(hre, localNetwork, localContractName)
    const feeConfig = await localContract.chainIdToFeeBps(remoteChainId)
    const curFeeBp = feeConfig.feeBP;
    const curEnabled = feeConfig.enabled;
    const needChange = curFeeBp !== feeBpConfig.feeBp || curEnabled !== feeBpConfig.enabled

    // function setFeeBp(uint16 _dstChainId, bool _enabled, uint16 _feeBp)
    const methodName = "setFeeBp"
    const params = ['uint16', 'bool', 'uint16']
    let args = [remoteChainId, feeBpConfig.enabled, feeBpConfig.feeBp]

    const tx: any = {
        needChange,
        chainId: crossChainHelper.getEndpointId(localNetwork),
        contractName: localContractName,
        methodName: methodName,
        args: args,
        calldata: generateCalldata(hre, methodName, params, args),
    }
    if (tx.needChange) {
        tx.diff = JSON.stringify({ feeBp: { oldFeeBpValue: curFeeBp, newFeeBpValue: feeBpConfig.feeBp, oldEnabledFee: curEnabled, newEnabledFee:  feeBpConfig.enabled} })
    }
    return [tx]
}

async function setMinDstGas(hre: any, localNetwork: string, localContractName: string, minDstGasConfig: [], remoteChainId: number): Promise<Transaction[]> {
    const txns: Transaction[] = []
    for (let i = 0; i < minDstGasConfig.length; i++) {
        const packetType = i;
        const minGas = minDstGasConfig[packetType]
        const localContract = await crossChainHelper.getContract(hre, localNetwork, localContractName)
        const cur = (await localContract.minDstGasLookup(remoteChainId, packetType)).toNumber()
        const needChange = cur !== minGas

        // function setMinDstGas(uint16 _dstChainId, uint16 _packetType, uint _minGas)
        const methodName = "setMinDstGas"
        const params = [
            'uint16',
            'uint16',
            'uint256'
        ]
        let args = [
            remoteChainId,
            packetType,
            minGas
        ]
        const tx: any = {
            needChange,
            chainId: crossChainHelper.getEndpointId(localNetwork),
            contractName: localContractName,
            methodName,
            args: args,
            calldata: generateCalldata(hre, methodName, params, args),
        }
        if (tx.needChange) {
            tx.diff = JSON.stringify({ oldValue: cur, newValue: minGas })
        }
        txns.push(tx)
    }
    return txns
}

async function setTrustedRemote(hre: any, localNetwork: string, localContractName: string, remoteNetwork: string, remoteContractName: string, environment: string): Promise<Transaction[]> {
    const localContract = await crossChainHelper.getContract(hre, localNetwork, localContractName)
    let remoteContractAddress;
    const remoteContract = await crossChainHelper.getContract(hre, remoteNetwork, remoteContractName)
    remoteContractAddress = await remoteContract.address
    const desiredTrustedRemote = ethers.utils.solidityPack(['bytes'], [remoteContractAddress + localContract.address.substring(2)])
    const remoteChainId = crossChainHelper.getEndpointId(remoteNetwork)
    const cur = await localContract.trustedRemoteLookup(remoteChainId)
    const needChange = cur != desiredTrustedRemote

    // function setTrustedRemote(uint16 _srcChainId, bytes calldata _path)
    const methodName = "setTrustedRemote"
    const params = ['uint16', 'bytes']
    let args = [remoteChainId, desiredTrustedRemote]

    const tx: any = {
        needChange,
        chainId: crossChainHelper.getEndpointId(localNetwork),
        contractName: localContractName,
        methodName: methodName,
        args: args,
        calldata: generateCalldata(hre, methodName, params, args),
    }
    if (tx.needChange) {
        tx.diff = JSON.stringify({trustedRemote: {oldValue: cur, newValue: desiredTrustedRemote}})
    }
    return [tx]
}

async function setInboundProofType(hre: any, localNetwork: string, localContractName: string, remoteChainId: number, inBoundProofType: number, lockDown: boolean = false): Promise<Transaction[]> {
    const localContract = await crossChainHelper.getContract(hre, localNetwork, localContractName)
    const VERSION = 2;
    const CONFIG_TYPE_INBOUND_PROOF_LIBRARY_VERSION = 1;
    const cur = await localContract.getConfig(VERSION,remoteChainId,ethers.constants.AddressZero,CONFIG_TYPE_INBOUND_PROOF_LIBRARY_VERSION)
    let config = ethers.utils.defaultAbiCoder.encode(
        ["uint16"],
        [inBoundProofType]
    )
    // set to true to lock down config
    const needChange = lockDown ? lockDown : cur !== config


    // function setConfig(uint16 _version, uint16 _chainId, uint _configType, bytes calldata _config)
    const methodName = "setConfig"
    const params = ['uint16', 'uint16', 'uint', 'bytes',]
    let args = [VERSION,remoteChainId,CONFIG_TYPE_INBOUND_PROOF_LIBRARY_VERSION,config]

    const tx: any = {
        needChange,
        chainId: crossChainHelper.getEndpointId(localNetwork),
        remoteChainId: remoteChainId,
        contractName: localContractName,
        methodName: "setInboundProofType",
        args: args,
        calldata: generateCalldata(hre, methodName, params, args),
    }
    if (tx.needChange) {
        tx.diff = JSON.stringify({ InboundProofType: { oldValue: cur, newValue: config } })
    }
    return [tx]
}

async function setInboundBlockConfirmations(hre: any, localNetwork: string, localContractName: string, remoteChainId: number, inBoundConfirmations: number, lockDown: boolean = false): Promise<Transaction[]> {
    const localContract = await crossChainHelper.getContract(hre, localNetwork, localContractName)
    const VERSION = 2;
    const CONFIG_TYPE_INBOUND_BLOCK_CONFIRMATIONS = 2;
    const cur = await localContract.getConfig(VERSION,remoteChainId,ethers.constants.AddressZero,CONFIG_TYPE_INBOUND_BLOCK_CONFIRMATIONS)
    let config = ethers.utils.defaultAbiCoder.encode(
        ["uint16"],
        [inBoundConfirmations]
    )
    const needChange = lockDown ? lockDown : cur !== config

    // function setConfig(uint16 _version, uint16 _chainId, uint _configType, bytes calldata _config)
    const methodName = "setConfig"
    const params = ['uint16', 'uint16', 'uint', 'bytes',]
    let args = [VERSION,remoteChainId,CONFIG_TYPE_INBOUND_BLOCK_CONFIRMATIONS,config]

    const tx: any = {
        needChange,
        chainId: crossChainHelper.getEndpointId(localNetwork),
        remoteChainId: remoteChainId,
        contractName: localContractName,
        methodName: "setInboundBlockConfirmations",
        args: args,
        calldata: generateCalldata(hre, methodName, params, args),
    }
    if (tx.needChange) {
        tx.diff = JSON.stringify({ InboundBlockConfirmations: { oldValue: cur, newValue: config } })
    }
    return [tx]
}

async function setRelayer(hre: any, localNetwork: string, localContractName: string, remoteChainId: number, relayerAddress: string, lockDown: boolean = false): Promise<Transaction[]> {
    const localContract = await crossChainHelper.getContract(hre, localNetwork, localContractName)
    const VERSION = 2;
    const CONFIG_TYPE_RELAYER = 3;
    const cur = await localContract.getConfig(VERSION,remoteChainId,ethers.constants.AddressZero,CONFIG_TYPE_RELAYER)
    let config = ethers.utils.defaultAbiCoder.encode(
        ["address"],
        [relayerAddress]
    )
    const needChange = lockDown ? lockDown : cur !== config

    // function setConfig(uint16 _version, uint16 _chainId, uint _configType, bytes calldata _config)
    const methodName = "setConfig"
    const params = ['uint16', 'uint16', 'uint', 'bytes',]
    let args = [VERSION,remoteChainId,CONFIG_TYPE_RELAYER,config]

    const tx: any = {
        needChange,
        chainId: crossChainHelper.getEndpointId(localNetwork),
        remoteChainId: remoteChainId,
        contractName: localContractName,
        methodName: "setRelayer",
        args: args,
        calldata: generateCalldata(hre, methodName, params, args),
    }
    if (tx.needChange) {
        tx.diff = JSON.stringify({ Relayer: { oldValue: cur, newValue: config } })
    }
    return [tx]
}

async function setOutboundProofType(hre: any, localNetwork: string, localContractName: string, remoteChainId: number, outBoundProofType: number, lockDown: boolean = false): Promise<Transaction[]> {
    const localContract = await crossChainHelper.getContract(hre, localNetwork, localContractName)
    const VERSION = 2;
    const CONFIG_TYPE_OUTBOUND_PROOF_TYPE = 4;
    const cur = await localContract.getConfig(VERSION,remoteChainId,ethers.constants.AddressZero,CONFIG_TYPE_OUTBOUND_PROOF_TYPE)
    let config = ethers.utils.defaultAbiCoder.encode(
        ["uint16"],
        [outBoundProofType]
    )
    const needChange = lockDown ? lockDown : cur !== config

    // function setConfig(uint16 _version, uint16 _chainId, uint _configType, bytes calldata _config)
    const methodName = "setConfig"
    const params = ['uint16', 'uint16', 'uint', 'bytes',]
    let args = [VERSION,remoteChainId,CONFIG_TYPE_OUTBOUND_PROOF_TYPE,config]

    const tx: any = {
        needChange,
        chainId: crossChainHelper.getEndpointId(localNetwork),
        remoteChainId: remoteChainId,
        contractName: localContractName,
        methodName: "setOutboundProofType",
        args: args,
        calldata: generateCalldata(hre, methodName, params, args),
    }
    if (tx.needChange) {
        tx.diff = JSON.stringify({ OutboundProofType: { oldValue: cur, newValue: config } })
    }
    return [tx]
}

async function setOutboundBlockConfirmations(hre: any, localNetwork: string, localContractName: string, remoteChainId: number, outBoundConfirmations: number, lockDown: boolean = false): Promise<Transaction[]> {
    const localContract = await crossChainHelper.getContract(hre, localNetwork, localContractName)
    const VERSION = 2;
    const CONFIG_TYPE_OUTBOUND_BLOCK_CONFIRMATIONS = 5;
    const cur = await localContract.getConfig(VERSION,remoteChainId,ethers.constants.AddressZero,CONFIG_TYPE_OUTBOUND_BLOCK_CONFIRMATIONS)
    let config = ethers.utils.defaultAbiCoder.encode(
        ["uint16"],
        [outBoundConfirmations]
    )
    const needChange = lockDown ? lockDown : cur !== config

    // function setConfig(uint16 _version, uint16 _chainId, uint _configType, bytes calldata _config)
    const methodName = "setConfig"
    const params = ['uint16', 'uint16', 'uint', 'bytes',]
    let args = [VERSION,remoteChainId,CONFIG_TYPE_OUTBOUND_BLOCK_CONFIRMATIONS,config]

    const tx: any = {
        needChange,
        chainId: crossChainHelper.getEndpointId(localNetwork),
        remoteChainId: remoteChainId,
        contractName: localContractName,
        methodName: "setOutboundBlockConfirmations",
        args: args,
        calldata: generateCalldata(hre, methodName, params, args),
    }
    if (tx.needChange) {
        tx.diff = JSON.stringify({ OutboundBlockConfirmations: { oldValue: cur, newValue: config } })
    }
    return [tx]
}

async function setOracle(hre: any, localNetwork: string, localContractName: string, remoteChainId: number, oracleAddress: string, lockDown: boolean = false): Promise<Transaction[]> {
    const localContract = await crossChainHelper.getContract(hre, localNetwork, localContractName)
    const VERSION = 2;
    const CONFIG_TYPE_ORACLE = 6;
    const cur = await localContract.getConfig(VERSION,remoteChainId,ethers.constants.AddressZero,CONFIG_TYPE_ORACLE)
    let config = ethers.utils.defaultAbiCoder.encode(
        ["address"],
        [oracleAddress]
    )
    const needChange = lockDown ? lockDown : cur !== config

    // function setConfig(uint16 _version, uint16 _chainId, uint _configType, bytes calldata _config)
    const methodName = "setConfig"
    const params = ['uint16', 'uint16', 'uint', 'bytes',]
    let args = [VERSION,remoteChainId,CONFIG_TYPE_ORACLE,config]

    const tx: any = {
        needChange,
        chainId: crossChainHelper.getEndpointId(localNetwork),
        remoteChainId: remoteChainId,
        contractName: localContractName,
        methodName: "setOracle",
        args: args,
        calldata: generateCalldata(hre, methodName, params, args),
    }

    if (tx.needChange) {
        tx.diff = JSON.stringify({ Oracle: { oldValue: cur, newValue: config } })
    }
    return [tx]
}

async function lockToSendAndRecvVersion(hre: any, localNetwork: string, localContractName: string, config: any, lockDown: boolean = false): Promise<Transaction[]> {
    const chainId = CHAIN_ID[localNetwork]
    const contractName = localContractName
    const transactions = []
    const contract = await crossChainHelper.getContract(hre, localNetwork, contractName)
    const endpoint = await crossChainHelper.getContractAt(hre, localNetwork, ABI, ENDPOINTS[localNetwork])

    const getSendVersion = await endpoint.getSendVersion(contract.address)
    const getReceiveVersion = await endpoint.getReceiveVersion(contract.address)
    const uaConfig = await endpoint.uaConfigLookup(contract.address)
    const currSendVersion = uaConfig[0]
    const currReceiveVersion = uaConfig[1]

    // SEND version
    let needChange = lockDown ? lockDown : currSendVersion !== config.sendVersion
    let methodName = "setSendVersion"
    let params = ['uint16']
    let args = [config.sendVersion]
    let tx = {
        needChange,
        chainId,
        remoteChainId: "",
        contractName,
        methodName,
        args,
        calldata: generateCalldata(hre, methodName, params, args)
    }
    if (needChange) {
        tx.diff = JSON.stringify({ SendVersion: { oldValue: currSendVersion, newValue: config.sendVersion }})
    }
    transactions.push(tx)

    // RECEIVE version
    needChange = lockDown ? lockDown : currReceiveVersion !== config.receiveVersion
    methodName = "setReceiveVersion"
    params = ['uint16']
    args = [config.receiveVersion]
    tx = {
        needChange,
        chainId,
        remoteChainId: "",
        contractName,
        methodName,
        args,
        calldata: generateCalldata(hre, methodName, params, args)
    }
    if (needChange) {
        tx.diff = JSON.stringify({ ReceiveVersion: { oldValue: currReceiveVersion, newValue: config.receiveVersion }})
    }
    transactions.push(tx)

    return transactions
}

export function validateStageOfNetworks(stage: ChainStage, localNetworks: string[], remoteNetworks: string[]) {
    const networks = getNetworkForStage(stage)
    localNetworks.forEach((network) => {
        if (!networks.includes(network)) {
            throw new Error(`Invalid network: ${network} for stage: ${stage}`)
        }
    })
    remoteNetworks.forEach((network) => {
        if (!networks.includes(network)) {
            throw new Error(`Invalid network: ${network} for stage: ${stage}`)
        }
    })
}

function getNetworkForStage(stage: ChainStage) {
    const networks: string[] = []
    for (const keyType in ChainKey) {
        const key = ChainKey[keyType as keyof typeof ChainKey]
        if (CHAIN_STAGE[key] === stage) {
            networks.push(key)
        }
    }
    return networks
}