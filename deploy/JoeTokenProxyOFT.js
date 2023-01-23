const LZ_ENDPOINTS = require("../constants/layerzeroEndpoints.json")
const {CHAIN_STAGE, ChainStage, ChainKey} = require("@layerzerolabs/lz-sdk");

const NETWORKS = [ChainKey.AVALANCHE, ChainKey.FUJI, ChainKey.FUJI_SANDBOX, "hardhat"]
const TRADER_JOE = {
    [ChainStage.MAINNET]: "0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd",
}

module.exports = async function ({ deployments, getNamedAccounts }) {
    if(!NETWORKS.includes(hre.network.name)) {
        throw new Error(`Can only deploy ProxyOFT on ${NETWORKS}`)
    }

    const { deploy } = deployments
    const { deployer } = await getNamedAccounts()
    console.log(`>>> your address: ${deployer}`)

    const lzEndpointAddress = LZ_ENDPOINTS[hre.network.name]
    console.log(`[${hre.network.name}] Endpoint Address: ${lzEndpointAddress}`)

    const stage = CHAIN_STAGE[hre.network.name]
    let tokenAddress = TRADER_JOE[stage] || (await deployments.get("Token")).address
    console.log(`Token Address: ${tokenAddress}`)

    await deploy("JoeTokenProxyOFT", {
        from: deployer,
        args: [tokenAddress, lzEndpointAddress],
        log: true,
        waitConfirmations: 1,
        skipIfAlreadyDeployed: true
    })
}

function getDependencies() {
    if (hre.network.name === "hardhat" || CHAIN_STAGE[hre.network.name] === ChainStage.TESTNET || CHAIN_STAGE[hre.network.name] === ChainStage.TESTNET_SANDBOX) {
        return ["Token"]
    }
}
module.exports.dependencies = getDependencies()
module.exports.tags = ["JoeTokenProxyOFT"]