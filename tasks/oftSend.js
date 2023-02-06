const {BigNumber} = require("ethers");
const {ChainStage, CHAIN_STAGE} = require("@layerzerolabs/lz-sdk");
const CHAIN_ID = require("@layerzerolabs/lz-sdk").CHAIN_ID
const TRADER_JOE = {
  [ChainStage.MAINNET]: "0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd",
}

module.exports = async function (taskArgs, hre) {
    let signers = await ethers.getSigners()
    let owner = signers[0]
    let toAddress = owner.address;
    let qty = BigNumber.from(taskArgs.qty)
    let localContract, remoteContract;

    if(taskArgs.contract) {
        localContract = taskArgs.contract;
        remoteContract = taskArgs.contract;
    } else {
        localContract = taskArgs.localContract;
        remoteContract = taskArgs.remoteContract;
    }

    if(!localContract || !remoteContract) {
        console.log("Must pass in contract name OR pass in both localContract name and remoteContract name")
        return
    }

    // get remote chain id
    const remoteChainId = CHAIN_ID[taskArgs.targetNetwork]

    // get local contract
    const localContractInstance = await ethers.getContract(localContract)

    // quote fee with default adapterParams
    let adapterParams = ethers.utils.solidityPack(["uint16", "uint256"], [1, 200000]) // default adapterParams example

    let toAddressBytes32 = ethers.utils.defaultAbiCoder.encode(['address'],[toAddress])
    console.log({toAddressBytes32})

    let fees = await localContractInstance.estimateSendFee(remoteChainId, toAddressBytes32, qty, false, adapterParams)
    console.log(`fees[0] (wei): ${fees[0]} / (eth): ${ethers.utils.formatEther(fees[0])}`)

    if(hre.network.name === "avalanche" || hre.network.name === "fuji" ) {
      const stage = CHAIN_STAGE[hre.network.name]
      let tokenAddress = TRADER_JOE[stage] || (await deployments.get("Token")).address
      console.log(`Token Address: ${tokenAddress}`)

      const Token = new ethers.Contract(
          tokenAddress,
          new ethers.utils.Interface([
            "function approve(address spender, uint256 amount) external returns (bool)"
          ])
      ).connect(ethers.getDefaultProvider())

      let tx = await (await Token.connect(owner).approve(localContractInstance.address, qty)).wait()
      console.log(`approve tx: ${tx.transactionHash}`)
    }
    let minQty = qty.mul(8).div(100);

    tx = await (
        await localContractInstance.sendFrom(
            owner.address,                                       // 'from' address to send tokens
            remoteChainId,                                       // remote LayerZero chainId
            toAddressBytes32,                                    // 'to' address to send tokens
            qty,                                                 // amount of tokens to send (in wei)
            minQty,                                              // min amount of tokens to send (in wei)
            {
                refundAddress: owner.address,                    // refund address (if too much message fee is sent, it gets refunded)
                zroPaymentAddress: ethers.constants.AddressZero, // address(0x0) if not paying in ZRO (LayerZero Token)
                adapterParams: adapterParams                     // flexible bytes array to indicate messaging adapter services
            },
            { value: fees[0] }
        )
    ).wait()
    console.log(`✅ Message Sent [${hre.network.name}] sendTokens() to OFT @ LZ chainId[${remoteChainId}] token:[${toAddress}]`)
    console.log(` tx: ${tx.transactionHash}`)
    console.log(`* check your address [${owner.address}] on the destination chain, in the ERC20 transaction tab !"`)
}
