const registry = new Map(); // address -> { permissionId, userId, connectedAt }
const usersByUserId = new Map(); // userId -> { address, permissionId, connectedAt }

export function register(address, permissionId, userId = null) {
  if (!address) return;
  
  // Store address in both lowercase (for lookup) and original format
  const normalizedLower = (address || "").toLowerCase();
  const normalizedOriginal = address.trim();
  
  // Handle null/0 permissionId (user connected but not delegated yet)
  const permId = (permissionId == null || permissionId === 0) ? null : Number(permissionId);
  
  const userData = {
    permissionId: permId,
    userId: userId || null,
    connectedAt: Date.now(),
    originalAddress: normalizedOriginal
  };
  
  // Store in both formats for lookup
  registry.set(normalizedLower, userData);
  registry.set(normalizedOriginal, userData);
  
  if (userId) {
    usersByUserId.set(String(userId), {
      address: normalizedOriginal, // Store original format
      addressLower: normalizedLower, // Also store lowercase for lookup
      permissionId: permId,
      connectedAt: Date.now()
    });
  }
}

export function getPermissionId(address) {
  if (!address) return null;
  // Try both lowercase and original case
  const normalized = (address || "").toLowerCase();
  let userData = registry.get(normalized);
  
  // If not found, try original case
  if (!userData) {
    userData = registry.get(address);
  }
  
  return userData?.permissionId ?? null;
}

export function getUserByAddress(address) {
  if (!address) return null;
  const normalized = (address || "").toLowerCase();
  return registry.get(normalized) || null;
}

export function getUserByUserId(userId) {
  if (!userId) return null;
  return usersByUserId.get(String(userId)) || null;
}

export function getAllUsers() {
  return Array.from(usersByUserId.entries()).map(([userId, data]) => ({
    userId,
    ...data
  }));
}

export function removeUser(userId) {
  const user = usersByUserId.get(String(userId));
  if (user) {
    registry.delete(user.address);
    usersByUserId.delete(String(userId));
  }
}

export default { 
  register, 
  getPermissionId, 
  getUserByAddress,
  getUserByUserId,
  getAllUsers,
  removeUser
};
