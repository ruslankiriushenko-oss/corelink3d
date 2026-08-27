import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  isAddress,
  parseAbi,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const DEFAULT_RPC = 'https://sepolia.base.org';
const DECIMALS = 6;
const abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Export it before running the test.`);
  return value;
}

function address(name: string): Address {
  const value = required(name);
  if (!isAddress(value)) throw new Error(`${name} is not a valid EVM address.`);
  return value as Address;
}

function privateKey(): Hex {
  const value = required('TEST_PRIVATE_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('TEST_PRIVATE_KEY must be a 32-byte hex key beginning with 0x.');
  }
  return value as Hex;
}

async function main() {
  const account = privateKeyToAccount(privateKey());
  const recipient = address('TEST_RECIPIENT_ADDRESS');
  const spender = address('TEST_SPENDER_ADDRESS');
  const amountText = process.env.TEST_AMOUNT_USDC || '0.01';
  const amount = parseUnits(amountText, DECIMALS);
  if (amount <= 0n) throw new Error('TEST_AMOUNT_USDC must be greater than zero.');
  if (account.address.toLowerCase() === recipient.toLowerCase()) {
    throw new Error('TEST_RECIPIENT_ADDRESS must differ from the sender.');
  }

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || DEFAULT_RPC;
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });

  const chainId = await publicClient.getChainId();
  if (chainId !== baseSepolia.id) throw new Error(`Wrong chain: expected ${baseSepolia.id}, got ${chainId}.`);

  const [ethBalance, usdcBalance] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: USDC, abi, functionName: 'balanceOf', args: [account.address] }),
  ]);
  console.log(`Network: Base Sepolia (${chainId})`);
  console.log(`Sender: ${account.address}`);
  console.log(`Recipient: ${recipient}`);
  console.log(`USDC contract: ${USDC}`);
  console.log(`Balances: ${formatUnits(usdcBalance, DECIMALS)} USDC, ${formatUnits(ethBalance, 18)} ETH`);

  if (usdcBalance < amount) {
    throw new Error(`Insufficient test USDC: need ${amountText}, have ${formatUnits(usdcBalance, DECIMALS)}.`);
  }
  if (ethBalance === 0n) throw new Error('Sender has no Base Sepolia ETH for gas.');

  console.log(`\n1/2 Approving ${amountText} USDC for ${spender}...`);
  const approvalHash = await walletClient.writeContract({
    address: USDC,
    abi,
    account,
    chain: baseSepolia,
    functionName: 'approve',
    args: [spender, amount],
  });
  const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash });
  if (approvalReceipt.status !== 'success') throw new Error(`Approval failed: ${approvalHash}`);
  const allowance = await publicClient.readContract({
    address: USDC,
    abi,
    functionName: 'allowance',
    args: [account.address, spender],
  });
  const approvalEvents = parseEventLogs({ abi, logs: approvalReceipt.logs, eventName: 'Approval' });
  const matchingApproval = approvalEvents.some((event) =>
    event.args.owner.toLowerCase() === account.address.toLowerCase()
    && event.args.spender.toLowerCase() === spender.toLowerCase()
    && event.args.value === amount,
  );
  if (allowance < amount || !matchingApproval) throw new Error('Approval state or event verification failed.');
  console.log(`Approval receipt: ${approvalHash}`);

  console.log(`2/2 Transferring ${amountText} USDC to recipient...`);
  const transferHash = await walletClient.writeContract({
    address: USDC,
    abi,
    account,
    chain: baseSepolia,
    functionName: 'transfer',
    args: [recipient, amount],
  });
  const transferReceipt = await publicClient.waitForTransactionReceipt({ hash: transferHash });
  if (transferReceipt.status !== 'success') throw new Error(`Transfer failed: ${transferHash}`);
  const transferEvents = parseEventLogs({ abi, logs: transferReceipt.logs, eventName: 'Transfer' });
  const matchingTransfer = transferEvents.some((event) =>
    event.args.from.toLowerCase() === account.address.toLowerCase()
    && event.args.to.toLowerCase() === recipient.toLowerCase()
    && event.args.value === amount,
  );
  if (!matchingTransfer) throw new Error('Transfer event verification failed.');
  console.log(`Transfer receipt: ${transferHash}`);
  console.log(`\nPASS: ${amountText} USDC transferred and verified on Base Sepolia.`);
  console.log(`Explorer: https://sepolia.basescan.org/tx/${transferHash}`);
}

main().catch((error: unknown) => {
  console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
