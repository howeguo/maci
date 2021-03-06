import * as ethers from 'ethers'
import * as prompt from 'prompt-async'

prompt.colors = false
prompt.message = ''

import { bigInt, SNARK_FIELD_SIZE } from 'maci-crypto'

import {
    MaciState,
} from 'maci-core'

import {
    PubKey,
    Keypair,
    Message,
    StateLeaf,
} from 'maci-domainobjs'

import {
    genJsonRpcDeployer,
} from 'maci-contracts'

import {
    maciContractAbi,
} from 'maci-contracts'

/*
 * Retrieves and parses on-chain MACI contract data to create an off-chain
 * representation as a MaciState object.
 * @param provider An Ethereum provider
 * @param address The address of the MACI contract
 * @coordinatorKeypair The coordinator's keypair
 */
const genMaciStateFromContract = async (
    provider: ethers.providers.Provider,
    address: string,
    coordinatorKeypair: Keypair,
    zerothLeaf: StateLeaf,
) => {

    const maciContract = new ethers.Contract(
        address,
        maciContractAbi,
        provider,
    )

    const treeDepths = await maciContract.treeDepths()
    const stateTreeDepth = bigInt(treeDepths[0].toString())
    const messageTreeDepth = bigInt(treeDepths[1].toString())
    const voteOptionTreeDepth = bigInt(treeDepths[2].toString())
    const maxVoteOptionIndex = bigInt((
            await maciContract.voteOptionsMaxLeafIndex()
        ).toString())

    const maciState = new MaciState(
        coordinatorKeypair,
        stateTreeDepth,
        messageTreeDepth,
        voteOptionTreeDepth,
        maxVoteOptionIndex,
    )

    const signUpLogs = await provider.getLogs({
        ...maciContract.filters.SignUp(),
        fromBlock: 0,
    })
    
    const publishMessageLogs = await provider.getLogs({
        ...maciContract.filters.PublishMessage(),
        fromBlock: 0,
    })

    const iface = new ethers.utils.Interface(maciContractAbi)
    for (const log of signUpLogs) {
        const event = iface.parseLog(log)
        const voiceCreditBalance = bigInt(event.values._voiceCreditBalance.toString())
        const pubKey = new PubKey([
            bigInt(event.values._userPubKey[0]),
            bigInt(event.values._userPubKey[1]),
        ])

        maciState.signUp(
            pubKey,
            voiceCreditBalance,
        )
    }

    for (const log of publishMessageLogs) {
        const event = iface.parseLog(log)
        const msgIv = bigInt(event.values._message[0].toString())
        const msgData = event.values._message[1].map((x) => bigInt(x.toString()))
        const message = new Message(msgIv, msgData)
        const encPubKey = new PubKey([
            bigInt(event.values._encPubKey[0]),
            bigInt(event.values._encPubKey[1]),
        ])

        maciState.publishMessage(message, encPubKey)
    }
    
    // Check whether the above steps were done correctly
    const onChainStateRoot = await maciContract.getStateTreeRoot()
    if (maciState.genStateRoot().toString(16) !== bigInt(onChainStateRoot).toString(16)) {
        throw new Error('Error: could not correctly recreate the state tree from on-chain data')
    }

    const onChainMessageRoot = await maciContract.getMessageTreeRoot()
    if (maciState.genMessageRoot().toString(16) !== bigInt(onChainMessageRoot).toString(16)) {
        throw new Error('Error: could not correctly recreate the message tree from on-chain data')
    }

    // Process the messages so that the users array is up to date with the
    // contract's state tree
    const postSignUpStateRoot = await maciContract.postSignUpStateRoot()
    const currentMessageBatchIndex = (await maciContract.currentMessageBatchIndex())
    const messageBatchSize = (await maciContract.messageBatchSize())

    for (let i = 0; i < currentMessageBatchIndex; i += messageBatchSize) {
        maciState.batchProcessMessage(
            i,
            messageBatchSize,
            zerothLeaf,
        )
    }

    if (maciState.genStateRoot().toString(16) !== bigInt(postSignUpStateRoot).toString(16)) {
        throw new Error('Error: could not correctly process messages to recreate the state')
    }

    return maciState
}

const calcBinaryTreeDepthFromMaxLeaves = (maxLeaves: number) => {
    let result = 0
    while (2 ** result < maxLeaves) {
        result ++
    }
    return result
}

const calcQuinTreeDepthFromMaxLeaves = (maxLeaves: number) => {
    let result = 0
    while (5 ** result < maxLeaves) {
        result ++
    }
    return result
}

const validateEthAddress = (address: string) => {
    return address.match(/^0x[a-fA-F0-9]{40}$/) != null
}

const promptPwd = async (name: string) => {
    prompt.start()
    const input = await prompt.get([
        {
            name,
            hidden: true,
        }
    ])

    return input[name]
}

const checkDeployerProviderConnection = async (
    sk: string,
    ethProvider: string,
) => {

    const deployer = genJsonRpcDeployer(sk, ethProvider)
    try {
        await deployer.provider.getBlockNumber()
    } catch {
        return false
    }

    return true
}

const validateSaltFormat = (salt: string): boolean => {
    return salt.match(/^0x[a-fA-F0-9]+$/) != null
}

const validateSaltSize = (salt: string): boolean => {
    return bigInt(salt) < SNARK_FIELD_SIZE
}

const validateEthSk = (sk: string): boolean => {
    try {
        new ethers.Wallet(sk)
    } catch {
        return false
    }
    return true
}

const contractExists = async (
    provider: ethers.providers.Provider,
    address: string,
) => {
    const code = await provider.getCode(address)
    return code.length > 2
}

export {
    promptPwd,
    calcBinaryTreeDepthFromMaxLeaves,
    calcQuinTreeDepthFromMaxLeaves,
    validateEthSk,
    checkDeployerProviderConnection,
    validateSaltSize,
    validateSaltFormat,
    validateEthAddress,
    contractExists,
    genMaciStateFromContract,
}
