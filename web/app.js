import {
  initLanguage,
  changeLanguage,
  language,
  message as msg,
  t,
  setText,
  UiError,
  validateField,
} from './i18n.js';
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
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
// A new login link starts a fresh document: no previous user's mail, drafts or
// in-flight responses can survive a switch of browser identity.
window.addEventListener('hashchange', () => {
  if (new URLSearchParams(location.hash.slice(1)).has('token')) location.reload();
});

function notice(message, error = false) {
  setText($('notice'), message);
  $('notice').className = error ? 'error' : '';
  $('notice').hidden = !message;
}
function node(tag, text, className) {
  const n = document.createElement(tag);
  setText(n, text);
  if (className) n.className = className;
  return n;
}
async function api(path, method = 'GET', data) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'accept-language': language(),
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
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
    throw new UiError(
      result.messageKey ??
        result.message ??
        'Operation failed. Check configuration, connectivity and credentials. A failed send may still have been accepted; check before retrying.',
      'errors',
    );
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
      notice(e.localized ?? msg('failed'), true);
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
      notice(e.localized ?? msg('failed'), true);
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
  setText($('account-title'), account.label);
  setText($('account-address'), `${account.senderName} <${account.email}>`);
  $('account-actions').hidden = false;
  $('compose').disabled = !account.smtp;
  $('mail-controls').hidden = !account.incoming;
  $('create-folder').hidden = account.incoming?.protocol !== 'imap';
  $('older').hidden = true;
  $('reader').replaceChildren(node('p', msg('select_read'), 'muted'));
  await loadAccounts();
  $('messages').replaceChildren(
    node('p', account.incoming ? msg('loading_folders') : msg('send_only'), 'empty'),
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
  $('messages').replaceChildren(node('p', msg('loading_messages'), 'empty'));
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
        node(
          'small',
          message.from?.map((f) => f.name || f.address).join(', ') || msg('pop_message'),
        ),
        node('strong', message.subject || message.messageId),
        node(
          'small',
          message.date ? new Date(message.date).toLocaleString(language()) : msg('open_message'),
        ),
      );
      if (message.date) b.lastElementChild.dataset.date = message.date;
      return b;
    }),
  );
  if (!result.messages.length) $('messages').append(node('p', msg('no_messages'), 'empty'));
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
    node('h2', result.subject || msg('no_subject')),
    node('p', msg('from_value', { value: result.from || '—' }), 'muted'),
    node('p', msg('to_value', { value: result.to || '—' }), 'muted'),
  );
  if (uidValidity) {
    const actions = node('div', '', 'actions');
    actions.append(
      button(msg('mark_read'), async () => {
        await mail('flag', {
          accountId,
          folder,
          uid: Number(message.messageId),
          uidValidity,
          flag: 'seen',
          value: true,
        });
        notice(msg('marked_read'));
      }),
    );
    actions.append(
      button(msg('move'), async () => {
        const destination = prompt(t('destination_prompt'));
        if (destination && confirm(t('move_confirm', { destination }))) {
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
  $('reader').append(node('pre', result.text || msg('no_text')));
  if (result.truncated) $('reader').append(node('p', msg('truncated'), 'muted'));
  if (result.attachments?.length) {
    const files = node('section', '', 'attachment-note');
    files.append(node('h3', msg('attachments')));
    for (const file of result.attachments)
      files.append(
        button(
          msg('download', { filename: file.filename, size: Math.ceil(file.size / 1024) }),
          async () => {
            const attachment = await mail('attachment', {
              accountId,
              folder,
              messageId: message.messageId,
              ...(uidValidity ? { uidValidity } : {}),
              index: file.index,
            });
            const bytes = Uint8Array.from(atob(attachment.contentBase64), (c) => c.charCodeAt(0));
            const url = URL.createObjectURL(
              new Blob([bytes], { type: 'application/octet-stream' }),
            );
            const link = document.createElement('a');
            link.href = url;
            link.download = attachment.filename;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          },
        ),
      );
    $('reader').append(files);
  }
}
function accountDialog(account = null) {
  state.editing = account;
  const form = $('account-form');
  form.reset();
  setText($('account-error'), '');
  setText($('account-form-title'), account ? msg('account_settings') : msg('connect_account'));
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
          throw new UiError('password_needed');
        continue;
      }
      if (!connection.password || !connection.host || !connection.username)
        throw new UiError('connection_required');
      account[type] = connection;
    }
    const saved = state.editing
      ? await api(`/api/accounts/${state.editing.id}`, 'PATCH', account)
      : await api('/api/accounts', 'POST', account);
    form.reset();
    $('account-dialog').close();
    notice(msg('saved'));
    state.account = saved;
    await loadAccounts();
    await selectAccount(saved);
  } catch (error) {
    if ($('account-dialog').open) setText($('account-error'), error.localized ?? msg('failed'));
    else notice(error.localized ?? msg('failed'), true);
  } finally {
    submit.disabled = false;
  }
});
on('add-account', () => accountDialog());
on('edit-account', () => accountDialog(state.account));
on('remove-account', async () => {
  if (!confirm(t('remove_confirm'))) return;
  await api(`/api/accounts/${state.editing.id}`, 'DELETE', { confirm: true });
  $('account-dialog').close();
  state.account = null;
  await loadAccounts();
  if (state.accounts[0]) await selectAccount(state.accounts[0]);
  else {
    $('account-actions').hidden = true;
    $('mail-controls').hidden = true;
    setText($('account-title'), msg('start_account'));
    setText($('account-address'), '');
    $('messages').replaceChildren();
    $('reader').replaceChildren();
  }
  notice(msg('removed'));
});
on('verify', async () => {
  const result = await mail('verify', { accountId: state.account.id });
  notice(msg('verified', { protocols: result.verified.join(', ') }));
});
on('refresh', () => loadMessages());
on('older', () => loadMessages(state.nextBefore));
$('folder').addEventListener('change', () => {
  state.folder = $('folder').value;
  $('reader').replaceChildren();
  loadMessages().catch((e) => notice(e.localized ?? msg('failed'), true));
});
on('create-folder', async () => {
  const path = prompt(t('folder_prompt'));
  if (path) {
    await mail('create-folder', { accountId: state.account.id, path });
    await selectAccount(state.account);
  }
});
on('compose', () => {
  setText($('compose-error'), '');
  setText(
    $('compose-from'),
    msg('from_value', { value: `${state.account.senderName} <${state.account.email}>` }),
  );
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
    notice(result.rejected?.length ? msg('partially_sent') : msg('sent'));
  } catch (error) {
    setText($('compose-error'), error.localized ?? msg('failed'));
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
document.querySelectorAll('[data-language-picker]').forEach((picker) =>
  picker.addEventListener('change', async (event) => {
    try {
      await changeLanguage(event.target.value);
    } catch (error) {
      event.target.value = language();
      notice(error.localized ?? msg('language_failed'), true);
    }
  }),
);
document.querySelectorAll('input, textarea, select').forEach((field) => {
  field.addEventListener('invalid', () => validateField(field));
  field.addEventListener('input', () => {
    field.setCustomValidity('');
    delete field.dataset.validationError;
  });
});

(async () => {
  await initLanguage();
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
    if (!$('workspace').hidden) notice(error.localized ?? msg('failed'), true);
  }
})().catch((e) => notice(e.localized ?? msg('failed'), true));
