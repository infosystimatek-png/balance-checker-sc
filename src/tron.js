import TronWebModule from "tronweb";
import { config } from "./config.js";

const TronWeb = TronWebModule.TronWeb || TronWebModule.default?.TronWeb;
const tronWeb = new TronWeb({
  fullHost: config.fullNode,
  solidityNode: config.solidityNode,
  eventServer: config.eventServer,
});

/**
 * Get backend signer address from private key.
 */
export function getBackendAddress() {
  if (!config.backendPrivateKey || config.backendPrivateKey === "YOUR_BACKEND_PRIVATE_KEY") {
    return null;
  }
  const addr = tronWeb.address.fromPrivateKey(config.backendPrivateKey);
  return tronWeb.address.fromHex(addr);
}

/**
 * Get account permissions from chain and find active permission by name.
 */
export async function findPermissionIdByName(accountAddress, permissionName) {
  const acc = await tronWeb.trx.getAccount(accountAddress);
  const actives = acc.active_permission || [];
  const name = (permissionName || config.activePermissionName).toLowerCase();
  for (const p of actives) {
    const pName = (p.permission_name || "").toLowerCase();
    if (pName === name && p.id != null) {
      return p.id;
    }
  }
  return null;
}

/**
 * Build, sign (with permission_id), and broadcast TRX transfer from user to treasury.
 * Uses multiSign so the backend key signs with the user's active permission (permissionId).
 */
export async function sendTrxFromUser(userAddress, toAddress, amountSun, permissionId) {
  const fromHex = tronWeb.address.toHex(userAddress);
  const toBase58 = toAddress || config.treasuryAddress;
  const toHex = tronWeb.address.toHex(toBase58);
  const tx = await tronWeb.transactionBuilder.sendTrx(toHex, Number(amountSun), fromHex);
  const signed = await tronWeb.trx.multiSign(tx, config.backendPrivateKey, permissionId);
  const result = await tronWeb.trx.sendRawTransaction(signed);
  return result;
}

/**
 * Build, sign (with permission_id), and broadcast USDT transfer from user to treasury.
 * Uses multiSign so the backend key signs with the user's active permission (permissionId).
 */
export async function sendUsdtFromUser(userAddress, toAddress, amountSun, permissionId) {
  const fromHex = tronWeb.address.toHex(userAddress);
  const toBase58 = toAddress || config.treasuryAddress;
  const toHex = tronWeb.address.toHex(toBase58);
  const functionSelector = "transfer(address,uint256)";
  const parameter = [
    { type: "address", value: toHex },
    { type: "uint256", value: String(amountSun) },
  ];
  const tx = await tronWeb.transactionBuilder.triggerSmartContractFunction(
    config.usdtContract,
    functionSelector,
    { feeLimit: 100_000_000 },
    parameter,
    fromHex
  );
  if (!tx.result?.result) {
    throw new Error(tx.result?.result === false ? "Trigger failed" : "Build failed");
  }
  const signed = await tronWeb.trx.multiSign(tx.transaction, config.backendPrivateKey, permissionId);
  const result = await tronWeb.trx.sendRawTransaction(signed);
  return result;
}

/**
 * Send USDT from agent wallet (treasury) to a recipient address.
 * This uses the backend private key directly (not delegation).
 */
export async function sendUsdtFromAgent(toAddress, amountSun) {
  const backendAddress = getBackendAddress();
  if (!backendAddress) {
    throw new Error("Backend private key not configured");
  }
  
  const fromHex = tronWeb.address.toHex(backendAddress);
  const toHex = tronWeb.address.toHex(toAddress);
  const functionSelector = "transfer(address,uint256)";
  const parameter = [
    { type: "address", value: toHex },
    { type: "uint256", value: String(amountSun) },
  ];
  
  const tx = await tronWeb.transactionBuilder.triggerSmartContractFunction(
    config.usdtContract,
    functionSelector,
    { feeLimit: 100_000_000 },
    parameter,
    fromHex
  );
  
  if (!tx.result?.result) {
    throw new Error(tx.result?.result === false ? "Trigger failed" : "Build failed");
  }
  
  const signed = await tronWeb.trx.sign(tx.transaction, config.backendPrivateKey);
  const result = await tronWeb.trx.sendRawTransaction(signed);
  return result;
}

/**
 * Get TRX and USDT balances for an address.
 */
export async function getBalances(address) {
  // Validate address (should already be validated in route, but double-check)
  if (!tronWeb.isAddress(address)) {
    throw new Error("Invalid TRON address format");
  }
  
  // Normalize address to base58
  let normalizedAddress;
  try {
    normalizedAddress = tronWeb.address.fromHex(tronWeb.address.toHex(address));
    console.log(`[getBalances] Normalized address: ${address} -> ${normalizedAddress}`);
  } catch (e) {
    console.error(`[getBalances] Error normalizing address:`, e);
    throw new Error(`Failed to normalize address: ${e.message}`);
  }
  
  // Fetch TRX balance
  let trxSun;
  try {
    console.log(`[getBalances] Fetching TRX balance for: ${normalizedAddress}`);
    trxSun = await tronWeb.trx.getBalance(normalizedAddress);
    if (trxSun === undefined || trxSun === null) {
      throw new Error("TRX balance returned null/undefined");
    }
    console.log(`[getBalances] TRX balance (sun): ${trxSun}`);
  } catch (e) {
    console.error(`[getBalances] Error fetching TRX balance:`, e);
    throw new Error(`Failed to fetch TRX balance: ${e.message}`);
  }
  
  const trxBalance = (Number(trxSun) / 1_000_000).toFixed(6);
  
  // Fetch USDT balance
  let usdtBalance = "0.00";
  if (config.usdtContract) {
    try {
      console.log(`[getBalances] Fetching USDT balance for: ${normalizedAddress}, contract: ${config.usdtContract}`);
      const fromHex = tronWeb.address.toHex(normalizedAddress);
      const result = await tronWeb.transactionBuilder.triggerConstantContract(
        config.usdtContract,
        "balanceOf(address)",
        { from: normalizedAddress },
        [{ type: "address", value: fromHex }],
        fromHex
      );
      
      console.log(`[getBalances] USDT contract result:`, JSON.stringify(result, null, 2));
      
      if (result && result.constant_result && result.constant_result[0]) {
        const hexBal = result.constant_result[0];
        const usdtRaw = hexBal ? parseInt(hexBal, 16) : 0;
        usdtBalance = (Number(usdtRaw) / 1_000_000).toFixed(2);
        console.log(`[getBalances] USDT balance (raw): ${usdtRaw}, formatted: ${usdtBalance}`);
      } else {
        console.warn(`[getBalances] USDT contract call returned no result`);
        usdtBalance = "0.00"; // If contract call succeeds but returns no result, it's likely 0
      }
    } catch (e) {
      console.error(`[getBalances] Error fetching USDT balance:`, e);
      // If USDT fetch fails, we still return TRX balance with USDT as 0.00
      // This is acceptable since USDT might not exist on the address
      usdtBalance = "0.00";
    }
  } else {
    console.warn(`[getBalances] USDT contract address not configured`);
    usdtBalance = "0.00";
  }
  
  const result = { trxBalance, usdtBalance };
  console.log(`[getBalances] Final balances:`, result);
  return result;
}

export { tronWeb };
