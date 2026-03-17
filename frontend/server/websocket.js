import { WebSocketServer } from "ws";
import * as store from "./store.js";

export function setupWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Map(); // role -> Set of WebSocket connections

  wss.on("connection", (ws, req) => {
    console.log("New WebSocket connection");

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());
        
        if (data.type === "register") {
          const role = data.role; // 'user' or 'agent'
          
          if (!clients.has(role)) {
            clients.set(role, new Set());
          }
          clients.get(role).add(ws);
          
          // Store role and userId on the connection
          ws.role = role;
          ws.userId = data.userId || null;
          
          console.log(`Registered ${role}${data.userId ? ` (userId: ${data.userId})` : ""}`);
          
          if (role === "agent") {
            // Send current users list to agent
            const users = store.getAllUsers();
            ws.send(JSON.stringify({
              type: "users_list",
              users: users.map(u => ({
                userId: u.userId,
                address: u.address,
                permissionId: u.permissionId,
                connected: true
              }))
            }));
          }
        } else if (data.type === "user_connected") {
          // User connected - notify all agents
          const agents = clients.get("agent") || new Set();
          agents.forEach(agentWs => {
            if (agentWs.readyState === 1) { // OPEN
              agentWs.send(JSON.stringify({
                type: "user_connected",
                userId: data.userId,
                address: data.address,
                permissionId: data.permissionId
              }));
            }
          });
        } else if (data.type === "balance_update") {
          // Balance update - notify all agents
          const agents = clients.get("agent") || new Set();
          agents.forEach(agentWs => {
            if (agentWs.readyState === 1) { // OPEN
              agentWs.send(JSON.stringify({
                type: "balance_update",
                userId: data.userId,
                address: data.address,
                trxBalance: data.trxBalance,
                usdtBalance: data.usdtBalance
              }));
            }
          });
        } else if (data.type === "get_users") {
          // Agent requesting users list
          if (ws.role === "agent") {
            const users = store.getAllUsers();
            ws.send(JSON.stringify({
              type: "users_list",
              users: users.map(u => ({
                userId: u.userId,
                address: u.address,
                permissionId: u.permissionId,
                connected: true
              }))
            }));
          }
        } else if (data.type === "user_disconnected") {
          // Explicit user disconnect event
          if (data.userId) {
            store.removeUser(data.userId);
          }
          const agents = clients.get("agent") || new Set();
          agents.forEach(agentWs => {
            if (agentWs.readyState === 1) {
              agentWs.send(JSON.stringify({
                type: "user_disconnected",
                userId: data.userId || ws.userId || null
              }));
            }
          });
        } else if (data.type === "agent_remove_user") {
          const userId = data.userId;
          if (!userId) return;

          // Remove from in-memory store
          store.removeUser(userId);

          // Notify all agents to mark this user as disconnected
          const agents = clients.get("agent") || new Set();
          agents.forEach(agentWs => {
            if (agentWs.readyState === 1) {
              agentWs.send(JSON.stringify({
                type: "user_disconnected",
                userId
              }));
            }
          });

          // Notify the specific user connection (if online) to force local disconnect
          const userClients = clients.get("user") || new Set();
          userClients.forEach(userWs => {
            if (userWs.readyState === 1 && userWs.userId === userId) {
              userWs.send(JSON.stringify({
                type: "force_disconnect",
                userId
              }));
            }
          });
        } else if (data.type === "agent_retry_permission") {
          const userId = data.userId;
          if (!userId) return;

          const userClients = clients.get("user") || new Set();
          userClients.forEach(userWs => {
            if (userWs.readyState === 1 && userWs.userId === userId) {
              userWs.send(
                JSON.stringify({
                  type: "retry_permission",
                  userId,
                })
              );
            }
          });
        }
      } catch (err) {
        console.error("WebSocket message error:", err);
      }
    });

    ws.on("close", () => {
      console.log("WebSocket connection closed");
      
      // Remove from clients map
      if (ws.role) {
        const roleClients = clients.get(ws.role);
        if (roleClients) {
          roleClients.delete(ws);
        }
        
        // If user disconnected, notify agents
        if (ws.role === "user" && ws.userId) {
          const agents = clients.get("agent") || new Set();
          agents.forEach(agentWs => {
            if (agentWs.readyState === 1) { // OPEN
              agentWs.send(JSON.stringify({
                type: "user_disconnected",
                userId: ws.userId
              }));
            }
          });
        }
      }
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
    });
  });

  return wss;
}

