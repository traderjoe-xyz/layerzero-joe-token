import { task, types } from "hardhat/config"

// npx hardhat --network arbitrum oftSend --qty 1000000000000000000 --target-network avalanche --local-contract JoeTokenOFT --remote-contract JoeTokenProxyOFT
task("oftSend", "send tokens to another chain", require("./oftSend"))
    .addParam("qty", "qty of tokens to send")
    .addParam("targetNetwork", "the target network to let this instance receive messages from")
    .addOptionalParam("localContract", "Name of local contract if the names are different")
    .addOptionalParam("remoteContract", "Name of remote contract if the names are different")
    .addOptionalParam("contract", "If both contracts are the same name")
