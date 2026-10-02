// Tiny fetch wrapper: adds the login token and turns errors into readable messages.
let token = localStorage.getItem('sh_token') || '';

export const getToken = () => token;

export function setToken(value) {
  token = value || '';
  if (token) localStorage.setItem('sh_token', token);
  else localStorage.removeItem('sh_token');
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch('/community/api' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (_) {
    const err = new Error('Cannot reach the StudyHub server. Check your connection and try again.');
    err.status = 0;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Something went wrong. Please try again.');
    err.status = res.status;
    // An expired session anywhere in the app sends the person back to the login screen.
    if (res.status === 401 && token && !path.startsWith('/login')) window.dispatchEvent(new Event('sh:unauthorized'));
    throw err;
  }
  return data;
}
