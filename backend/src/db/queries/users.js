export async function getUserByPhone(phoneNumber) {
  // TODO
}

export async function createUser(phoneNumber) {
  // TODO
}

export async function setUserState(userId, state, stateContext = {}) {
  // TODO: see spec section 12.1 (Conversation State Machine)
}

export async function linkGoogleAccount(userId, googleId) {
  // TODO: bind google_id, invalidate link_token (see spec section 2.5)
}
