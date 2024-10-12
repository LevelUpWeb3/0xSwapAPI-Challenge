import { config as dotenv } from "dotenv";
import {
  createWalletClient,
  http,
  getContract,
  erc20Abi,
  parseUnits,
  maxUint256,
  publicActions,
  concat,
  numberToHex,
  size,
} from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { scroll } from "viem/chains";
import { wethAbi } from "./abi/weth-abi";

// For the 0x Challenge on Scroll, implement the following:
// 1. Display the percentage breakdown of liquidity sources
// 2. Monetize your app with affiliate fees and surplus collection
// 3. Display buy/sell tax for tokens with tax
// 4. Display all sources of liquidity on Scroll

const qs = require("qs");

// Load environment variables
dotenv();
const { PRIVATE_KEY, ZERO_EX_API_KEY, ALCHEMY_HTTP_TRANSPORT_URL } = process.env;

// Validate environment variables
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY.");
if (!ZERO_EX_API_KEY) throw new Error("Missing ZERO_EX_API_KEY.");
if (!ALCHEMY_HTTP_TRANSPORT_URL) throw new Error("Missing ALCHEMY_HTTP_TRANSPORT_URL.");

// Set request headers
const headers = new Headers({
  "Content-Type": "application/json",
  "0x-api-key": ZERO_EX_API_KEY,
  "0x-version": "v2",
});

// Initialize wallet client
const client = createWalletClient({
  account: privateKeyToAccount(`0x${PRIVATE_KEY}` as `0x${string}`),
  chain: scroll,
  transport: http(ALCHEMY_HTTP_TRANSPORT_URL),
}).extend(publicActions); // Extend wallet client with public actions

const [address] = await client.getAddresses();

// Set up contracts
const weth = getContract({
  address: "0x5300000000000000000000000000000000000004",
  abi: wethAbi,
  client,
});

const wsteth = getContract({
  address: "0xf610A9dfB7C89644979b4A0f27063E9e7d7Cda32",
  abi: erc20Abi,
  client,
});

const main = async () => {
  // Specify sell amount
  const decimals = await weth.read.decimals() as number;
  const sellAmount = parseUnits("0.1", decimals);

  // Fetch price
  const priceParams = new URLSearchParams({
    chainId: client.chain.id.toString(),
    sellToken: weth.address,
    buyToken: wsteth.address,
    sellAmount: sellAmount.toString(),
    taker: client.account.address,
  });

  const priceResponse = await fetch(
    `https://api.0x.org/swap/permit2/price?${priceParams.toString()}`,
    { headers }
  );
  const price = await priceResponse.json();
  console.log("Fetching price to swap 0.1 WETH for wstETH", price);

  // Check if allowance needs to be set for Permit2
  if (price.issues?.allowance !== null) {
    try {
      const { request } = await weth.simulate.approve([
        price.issues.allowance.spender,
        maxUint256,
      ]);
      console.log("Approving Permit2 to spend WETH...", request);
      
      // Set approval
      const hash = await weth.write.approve(request.args);
      console.log(
        "Approved Permit2 to spend WETH.",
        await client.waitForTransactionReceipt({ hash })
      );
    } catch (error) {
      console.error("Error approving Permit2:", error);
    }
  } else {
    console.log("WETH already approved for Permit2");
  }

  // Fetch quote
  const quoteParams = new URLSearchParams(priceParams);
  const quoteResponse = await fetch(
    `https://api.0x.org/swap/permit2/quote?${quoteParams.toString()}`,
    { headers }
  );
  const quote = await quoteResponse.json();
  console.log("Fetching quote to swap 0.1 WETH for wstETH", quote);

  // Sign permit2.eip712 returned from quote
  let signature: Hex | undefined;
  if (quote.permit2?.eip712) {
    try {
      signature = await client.signTypedData(quote.permit2.eip712);
      console.log("Signed permit2 message from quote response");
    } catch (error) {
      console.error("Error signing permit2 coupon:", error);
    }

    // Append signature to transaction data
    if (signature && quote?.transaction?.data) {
      const sigLengthHex = numberToHex(size(signature), { signed: false, size: 32 }) as Hex;
      const sig = signature as Hex;
      quote.transaction.data = concat([quote.transaction.data as Hex, sigLengthHex, sig]);
    } else {
      throw new Error("Failed to obtain signature or transaction data");
    }
  }

  // Submit transaction with permit2 signature
  if (signature && quote.transaction.data) {
    const nonce = await client.getTransactionCount({ address: client.account.address });

    const signedTransaction = await client.signTransaction({
      account: client.account,
      chain: client.chain,
      gas: quote?.transaction.gas ? BigInt(quote.transaction.gas) : undefined,
      to: quote?.transaction.to,
      data: quote.transaction.data,
      value: quote?.transaction.value ? BigInt(quote.transaction.value) : undefined,
      gasPrice: quote?.transaction.gasPrice ? BigInt(quote.transaction.gasPrice) : undefined,
      nonce,
    });
    const hash = await client.sendRawTransaction({ serializedTransaction: signedTransaction });

    console.log("Transaction hash:", hash);
    console.log(`See transaction details at https://scrollscan.com/tx/${hash}`);
  } else {
    console.error("Failed to obtain a signature, transaction not sent.");
  }
};

main();
