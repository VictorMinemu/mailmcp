const $ = (id) => document.getElementById(id);
const state = {
  accounts: [],
  account: null,
  editing: null,
  folder: 'INBOX',
  uidValidity: undefined,
  nextBefore: null,
  generation: 0,
};
let loginToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (location.hash) history.replaceState(null, '', location.pathname);
// A new login link starts a fresh document: no previous user's mail, drafts or
// in-flight responses can survive a switch of browser identity.
window.addEventListener('hashchange', () => {
  if (new URLSearchParams(location.hash.slice(1)).has('token')) location.reload();
});

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').className = error ? 'error' : '';
  $('notice').hidden = !message;
}
function node(tag, text, className) {
  const n = document.createElement(tag);
  n.textContent = text;
  if (className) n.className = className;
  return n;
}
async function api(path, method = 'GET', data) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: data === undefined ? {} : { 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/redeem') {
      $('workspace').hidden = true;
      $('welcome').hidden = false;
      $('logout').hidden = true;
      state.accounts = [];
      state.account = null;
      $('accounts').replaceChildren();
      $('messages').replaceChildren();
      $('reader').replaceChildren();
      document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    }
    throw new Error(result.message || 'No se pudo completar la operación.');
  }
  return result;
}
const mail = (operation, data) => api(`/api/mail/${operation}`, 'POST', data);
function on(id, callback) {
  $(id).addEventListener('click', async () => {
    const button = $(id);
    button.disabled = true;
    try {
      await callback();
    } catch (e) {
      notice(e.message, true);
    } finally {
      button.disabled = false;
    }
  });
}
function button(text, callback) {
  const b = node('button', text, 'quiet');
  b.type = 'button';
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await callback();
    } catch (e) {
      notice(e.message, true);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
async function loadAccounts() {
  state.accounts = await api('/api/accounts');
  $('welcome').hidden = true;
  $('workspace').hidden = false;
  $('logout').hidden = false;
  $('accounts').replaceChildren(
    ...state.accounts.map((a) => {
      const b = button(a.label, () => selectAccount(a));
      b.append(node('small', a.email));
      if (a.id === state.account?.id) b.className = 'selected';
      return b;
    }),
  );
}
async function selectAccount(account) {
  state.generation++;
  state.account = account;
  state.folder = 'INBOX';
  state.nextBefore = null;
  $('account-title').textContent = account.label;
  $('account-address').textContent = `${account.senderName} <${account.email}>`;
  $('account-actions').hidden = false;
  $('compose').disabled = !account.smtp;
  $('mail-controls').hidden = !account.incoming;
  $('create-folder').hidden = account.incoming?.protocol !== 'imap';
  $('older').hidden = true;
  $('reader').replaceChildren(node('p', 'Selecciona un mensaje para leerlo.', 'muted'));
  await loadAccounts();
  $('messages').replaceChildren(
    node(
      'p',
      account.incoming ? 'Consultando carpetas…' : 'Esta cuenta está configurada solo para enviar.',
      'empty',
    ),
  );
  if (!account.incoming) return;
  const generation = state.generation,
    folders = await mail('folders', { accountId: account.id });
  if (generation !== state.generation) return;
  $('folder').replaceChildren(
    ...folders.map((f) => {
      const option = node('option', f.name);
      option.value = f.path;
      return option;
    }),
  );
  if (folders.some((f) => f.path === 'INBOX')) $('folder').value = 'INBOX';
  state.folder = $('folder').value || 'INBOX';
  await loadMessages();
}
async function loadMessages(before) {
  if (!state.account?.incoming) return;
  const generation = ++state.generation;
  $('messages').replaceChildren(node('p', 'Consultando mensajes…', 'empty'));
  $('older').hidden = true;
  const result = await mail('list', {
    accountId: state.account.id,
    folder: state.folder,
    limit: 20,
    ...(before ? { before } : {}),
  });
  if (generation !== state.generation) return;
  state.uidValidity = result.uidValidity;
  state.nextBefore = result.nextBefore;
  $('older').hidden = !result.nextBefore;
  $('messages').replaceChildren(
    ...result.messages.map((message) => {
      const b = button('', () => readMessage(message));
      b.className = 'message';
      b.append(
        node('small', message.from?.map((f) => f.name || f.address).join(', ') || 'Mensaje POP3'),
        node('strong', message.subject || message.messageId),
        node('small', message.date ? new Date(message.date).toLocaleString() : 'Abrir mensaje'),
      );
      return b;
    }),
  );
  if (!result.messages.length)
    $('messages').append(node('p', 'No hay mensajes en esta carpeta.', 'empty'));
}
async function readMessage(message) {
  const generation = state.generation,
    accountId = state.account.id,
    folder = state.folder,
    uidValidity = state.uidValidity;
  const result = await mail('read', {
    accountId,
    folder,
    messageId: message.messageId,
    ...(uidValidity ? { uidValidity } : {}),
  });
  if (generation !== state.generation) return;
  $('reader').replaceChildren(
    node('h2', result.subject || '(Sin asunto)'),
    node('p', `De: ${result.from || '—'}`, 'muted'),
    node('p', `Para: ${result.to || '—'}`, 'muted'),
  );
  if (uidValidity) {
    const actions = node('div', '', 'actions');
    actions.append(
      button('Marcar como leído', async () => {
        await mail('flag', {
          accountId,
          folder,
          uid: Number(message.messageId),
          uidValidity,
          flag: 'seen',
          value: true,
        });
        notice('Mensaje marcado como leído.');
      }),
    );
    actions.append(
      button('Mover a carpeta', async () => {
        const destination = prompt('Nombre exacto de la carpeta de destino:');
        if (destination && confirm(`¿Mover este mensaje a ${destination}?`)) {
          await mail('move', {
            accountId,
            folder,
            uid: Number(message.messageId),
            uidValidity,
            destination,
            confirm: true,
          });
          $('reader').replaceChildren();
          await loadMessages();
        }
      }),
    );
    $('reader').append(actions);
  }
  $('reader').append(node('pre', result.text || 'Este mensaje no contiene texto legible.'));
  if (result.truncated)
    $('reader').append(node('p', 'El texto se ha recortado por su tamaño.', 'muted'));
  if (result.attachments?.length) {
    const files = node('section', '', 'attachment-note');
    files.append(node('h3', 'Adjuntos'));
    for (const file of result.attachments)
      files.append(
        button(`Descargar ${file.filename} (${Math.ceil(file.size / 1024)} KB)`, async () => {
          const attachment = await mail('attachment', {
            accountId,
            folder,
            messageId: message.messageId,
            ...(uidValidity ? { uidValidity } : {}),
            index: file.index,
          });
          const bytes = Uint8Array.from(atob(attachment.contentBase64), (c) => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
          const link = document.createElement('a');
          link.href = url;
          link.download = attachment.filename;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }),
      );
    $('reader').append(files);
  }
}
function accountDialog(account = null) {
  state.editing = account;
  const form = $('account-form');
  form.reset();
  $('account-error').textContent = '';
  $('account-form-title').textContent = account
    ? 'Configuración de la cuenta'
    : 'Conectar una cuenta';
  $('remove-account').hidden = !account;
  if (account) {
    for (const key of ['label', 'email', 'senderName', 'replyTo'])
      form.elements[key].value = account[key] || '';
    form.elements.incomingProtocol.value = account.incoming?.protocol || 'none';
    form.elements.smtpEnabled.checked = !!account.smtp;
    for (const type of ['incoming', 'smtp'])
      for (const field of ['host', 'port', 'security', 'username'])
        if (account[type])
          form.elements[type + field[0].toUpperCase() + field.slice(1)].value =
            account[type][field];
  }
  $('account-dialog').showModal();
}
$('account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target,
    data = new FormData(form),
    get = (key) => String(data.get(key) || '');
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const account = {
      label: get('label'),
      email: get('email'),
      senderName: get('senderName'),
      ...(get('replyTo') ? { replyTo: get('replyTo') } : state.editing ? { replyTo: null } : {}),
    };
    for (const type of ['incoming', 'smtp']) {
      const enabled =
        type === 'incoming' ? get('incomingProtocol') !== 'none' : data.has('smtpEnabled');
      if (!enabled) {
        if (state.editing) account[type] = null;
        continue;
      }
      const connection = {
        host: get(type + 'Host')
          .trim()
          .toLowerCase(),
        port: Number(get(type + 'Port')),
        security: get(type + 'Security'),
        username: get(type + 'Username'),
        password: get(type + 'Password'),
        ...(type === 'incoming' ? { protocol: get('incomingProtocol') } : {}),
      };
      if (!connection.password && state.editing?.[type]) {
        if (
          Object.entries(connection).some(
            ([k, v]) => k !== 'password' && state.editing[type][k] !== v,
          )
        )
          throw new Error('Introduce la contraseña para guardar los cambios de conexión.');
        continue;
      }
      if (!connection.password || !connection.host || !connection.username)
        throw new Error('Completa servidor, usuario y contraseña de cada conexión habilitada.');
      account[type] = connection;
    }
    const saved = state.editing
      ? await api(`/api/accounts/${state.editing.id}`, 'PATCH', account)
      : await api('/api/accounts', 'POST', account);
    form.reset();
    $('account-dialog').close();
    notice('Cuenta guardada. Puedes probar la conexión.');
    state.account = saved;
    await loadAccounts();
    await selectAccount(saved);
  } catch (error) {
    if ($('account-dialog').open) $('account-error').textContent = error.message;
    else notice(error.message, true);
  } finally {
    submit.disabled = false;
  }
});
on('add-account', () => accountDialog());
on('edit-account', () => accountDialog(state.account));
on('remove-account', async () => {
  if (!confirm('¿Eliminar esta conexión? El correo permanecerá en tu proveedor.')) return;
  await api(`/api/accounts/${state.editing.id}`, 'DELETE', { confirm: true });
  $('account-dialog').close();
  state.account = null;
  await loadAccounts();
  if (state.accounts[0]) await selectAccount(state.accounts[0]);
  else {
    $('account-actions').hidden = true;
    $('mail-controls').hidden = true;
    $('account-title').textContent = 'Empieza con una cuenta';
    $('account-address').textContent = '';
    $('messages').replaceChildren();
    $('reader').replaceChildren();
  }
  notice('Conexión eliminada.');
});
on('verify', async () => {
  const result = await mail('verify', { accountId: state.account.id });
  notice(`Conexión verificada: ${result.verified.join(', ')}.`);
});
on('refresh', () => loadMessages());
on('older', () => loadMessages(state.nextBefore));
$('folder').addEventListener('change', () => {
  state.folder = $('folder').value;
  $('reader').replaceChildren();
  loadMessages().catch((e) => notice(e.message, true));
});
on('create-folder', async () => {
  const path = prompt('Nombre de la nueva carpeta:');
  if (path) {
    await mail('create-folder', { accountId: state.account.id, path });
    await selectAccount(state.account);
  }
});
on('compose', () => {
  $('compose-error').textContent = '';
  $('compose-from').textContent = `De: ${state.account.senderName} <${state.account.email}>`;
  $('compose-dialog').showModal();
});
$('compose-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target,
    data = new FormData(form),
    submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const result = await mail('send', {
      accountId: state.account.id,
      to: String(data.get('to'))
        .split(',')
        .map((s) => s.trim()),
      subject: data.get('subject'),
      text: data.get('text'),
      confirm: data.has('confirm'),
    });
    form.reset();
    $('compose-dialog').close();
    notice(
      result.rejected?.length
        ? 'El servidor rechazó algunos destinatarios. Revisa el envío en tu proveedor.'
        : 'El servidor aceptó el mensaje para su envío.',
    );
  } catch (error) {
    $('compose-error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
document
  .querySelectorAll('.close-dialog')
  .forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
$('account-dialog').addEventListener('close', () => {
  $('account-form').elements.incomingPassword.value = '';
  $('account-form').elements.smtpPassword.value = '';
});
on('logout', async () => {
  await api('/api/logout', 'POST', {});
  location.reload();
});
on('redeem', async () => {
  const token = loginToken;
  loginToken = null;
  $('redeem').hidden = true;
  await api('/api/redeem', 'POST', { token });
  await loadAccounts();
  if (state.accounts[0]) await selectAccount(state.accounts[0]);
});
(async () => {
  const config = await api('/api/config');
  $('login').hidden = !config.hosted;
  $('local-help').hidden = config.hosted;
  if (loginToken) {
    $('redeem').hidden = false;
    $('login').hidden = true;
    return;
  }
  try {
    await loadAccounts();
    if (state.accounts[0]) await selectAccount(state.accounts[0]);
  } catch (error) {
    if (!$('workspace').hidden) notice(error.message, true);
  }
})().catch((e) => notice(e.message, true));
