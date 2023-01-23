const {BigNumber} = require("ethers");
const CHAIN_ID = require("@layerzerolabs/lz-sdk").CHAIN_ID

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

    let toAddressBytes32 = "0x000000000000000000000000" + toAddress.toString().substring(2) // bytes32(uint256(uint160(toAddress)) << 96)//ethers.utils.solidityPack(["bytes32"], [toAddress.toString()])
    console.log({toAddressBytes32})

    let fees = await localContractInstance.estimateSendFee(remoteChainId, toAddressBytes32, qty, false, adapterParams)
    console.log(`fees[0] (wei): ${fees[0]} / (eth): ${ethers.utils.formatEther(fees[0])}`)

    // for testnet
    const Token = new ethers.Contract(
        "0x81f5Eac55F8202379Ff4DE8C472E59f0C252B910",
        new ethers.utils.Interface([
            "function approve(address spender, uint256 amount) external returns (bool)"
        ])
    ).connect(ethers.getDefaultProvider())

    let tx = await (await Token.connect(owner).approve(localContractInstance.address, qty)).wait()
    console.log(`approve tx: ${tx.transactionHash}`)
    let minQty = qty.mul(8).div(100);

    tx = await (
        await localContractInstance.sendFrom(
            owner.address,                                       // 'from' address to send tokens
            remoteChainId,                                       // remote LayerZero chainId
            toAddressBytes32,                                           // 'to' address to send tokens
            qty,                                                 // amount of tokens to send (in wei)
            minQty,                            // min amount of tokens to send (in wei)
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
