import TronWebModule from "tronweb";
import { config } from "./config.js";

const TronWeb = TronWebModule.TronWeb || TronWebModule.default?.TronWeb;
let _tronWeb = null;

function getTronWeb() {
  if (_tronWeb) return _tronWeb;
  _tronWeb = new TronWeb({
    fullHost: config.fullNode,
    solidityNode: config.solidityNode,
    eventServer: config.eventServer,
  });
  return _tronWeb;
}

export function getBackendAddress() {
  if (!config.backendPrivateKey || config.backendPrivateKey === "YOUR_BACKEND_PRIVATE_KEY") {
    return null;
  }
  try {
    const tronWeb = getTronWeb();
    const addr = tronWeb.address.fromPrivateKey(config.backendPrivateKey);
    return tronWeb.address.fromHex(addr);
  } catch (e) {
    console.error("getBackendAddress error:", e.message);
    return null;
  }
}

export async function findPermissionIdByName(accountAddress, permissionName) {
  const tronWeb = getTronWeb();
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

export async function sendTrxFromUser(userAddress, toAddress, amountSun, permissionId) {
  const tronWeb = getTronWeb();
  const fromHex = tronWeb.address.toHex(userAddress);
  const toBase58 = toAddress || config.treasuryAddress;
  const toHex = tronWeb.address.toHex(toBase58);
  const tx = await tronWeb.transactionBuilder.sendTrx(toHex, Number(amountSun), fromHex);
  const signed = await tronWeb.trx.multiSign(tx, config.backendPrivateKey, permissionId);
  return await tronWeb.trx.sendRawTransaction(signed);
}

export async function sendUsdtFromUser(userAddress, toAddress, amountSun, permissionId) {
  const tronWeb = getTronWeb();
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
  return await tronWeb.trx.sendRawTransaction(signed);
}

export async function sendUsdtFromAgent(toAddress, amountSun) {
  const backendAddress = getBackendAddress();
  if (!backendAddress) {
    throw new Error("Backend private key not configured");
  }
  
  const tronWeb = getTronWeb();
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
  return await tronWeb.trx.sendRawTransaction(signed);
}

export { getTronWeb };
