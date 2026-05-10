let messages = [];
let isStreaming = false;
let currentController = null;

const $ = (id) => document.getElementById(id);
const input = $('messageInput');
const sendBtn = $('sendBtn');
const wrapper = $('messagesWrapper');
const welcomeView = $('welcomeView');

input.addEventListener('input', () => {
  sendBtn.disabled = !input.value.trim();
});

function getSettings() {
  return {
    apiUrl: localStorage.getItem('apiUrl') || location.origin,
    apiKey: localStorage.getItem('apiKey') || '',
    temperature: parseFloat(localStorage.getItem('temperature') || '0.7'),
    maxTokens: parseInt(localStorage.getItem('maxTokens') || '4096')
  };
}

function saveSettings() {
  const s = {
    apiUrl: $('apiUrlInput').value || location.origin,
    apiKey: $('apiKeyInput').value,
    temperature: $('tempInput').value,
    maxTokens: $('maxTokensInput').value
  };
  Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v));
  showToast('设置已保存', 'success');
}

function loadSettings() {
  const s = getSettings();
  $('apiUrlInput').value = s.apiUrl;
  $('apiKeyInput').value = s.apiKey;
  $('tempInput').value = s.temperature;
  $('maxTokensInput').value = s.maxTokens;
  $('tempValue').textContent = s.temperature;
  $('tempInput').addEventListener('input', (e) => {
    $('tempValue').textContent = e.target.value;
  });
}

function toggleSettings() {
  $('settingsBackdrop').classList.toggle('visible');
  $('settingsDrawer').classList.toggle('open');
}

function toggleSidebar() {
  $('sidebar').classList.toggle('open');
}

function onInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 150) + 'px';
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && !isStreaming && input.value.trim()) {
    e.preventDefault();
    sendMessage();
  }
}

function sendMessage() {
  const content = input.value.trim();
  if (!content || isStreaming) return;

  addMessage('user', content);
  input.value = '';
  input.style.height = 'auto';
  sendBtn.disabled = true;
  hideWelcome();
  sendToAPI(content);
}

function sendQuickPrompt(text) {
  input.value = text;
  sendMessage();
}

function addMessage(role, content) {
  messages.push({ role, content });
  renderMessage(role, content);
}

function renderMessage(role, content, isTyping = false) {
  const row = document.createElement('div');
  row.className = `message-row ${role}`;

  const avatarChar = role === 'assistant' ? 'F' : 'U';
  const label = role === 'assistant' ? '助手' : '你';
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });

  let bodyHtml = isTyping ? '<span class="typing-cursor">&nbsp;</span>' : formatContent(content);

  row.innerHTML = `
    <div class="msg-avatar ${role}">${avatarChar}</div>
    <div class="msg-body">
      <div class="msg-meta">${label}<span style="margin-left:auto;opacity:0.5">${time}</span></div>
      <div class="msg-content">${bodyHtml}</div>
      <div class="msg-actions">
        <button class="action-link" onclick="copyMsg(this)">复制</button>
      </div>
    </div>`;

  wrapper.appendChild(row);
  scrollBottom();
  return row;
}

function formatContent(text) {
  if (typeof text !== 'string') return text;

  const codeBlocks = [];
  let placeholderIndex = 0;
  const inlineCodes = [];
  let inlineIndex = 0;

  function extractCodeBlocks(str) {
    return str.replace(/```(\w*)\s*([\s\S]*?)```/g, (match, lang, code) => {
      const idx = placeholderIndex++;
      const langName = lang || 'text';
      const trimmedCode = code.replace(/^\n?/, '').replace(/\n?$/, '');
      codeBlocks[idx] = `<div class="code-block" data-lang="${langName}"><pre><code class="lang-${langName}">${trimmedCode.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code></pre></div>`;
      return `\x00CODEBLOCK${idx}\x00`;
    });
  }

  let out = extractCodeBlocks(text);

  out = out
    .replace(/`([^`\n]+)`/g, (match, code) => {
      if (match.startsWith('```')) return match;
      return `\x00RAWINLINE${encodeURIComponent(code)}\x00`;
    });

  out = out
    .replace(/<code\s+class=["']?inline-code["']?\s*>([\s\S]*?)<\/code>/gi, (match, content) => {
      const idx = inlineIndex++;
      inlineCodes[idx] = `<code class="inline-code">${content}</code>`;
      return `\x00INLINE${idx}\x00`;
    });

  out = out
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  out = out
    .replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => codeBlocks[idx] || '')
    .replace(/\x00INLINE(\d+)\x00/g, (_, idx) => inlineCodes[idx] || '')
    .replace(/\x00RAWINLINE([^\x00]*)\x00/g, (_, encoded) => {
      const code = decodeURIComponent(encoded);
      return `<code class="inline-code">${code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code>`;
    })
    .replace(/\n/g, '<br>');

  return out;
}

function updateLastAssistant(content) {
  const last = wrapper.querySelector('.message-row.assistant:last-child');
  if (last) {
    const bubble = last.querySelector('.msg-content');
    bubble.innerHTML = formatContent(content);

    if (!bubble.parentElement.querySelector('.msg-actions')) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      actions.innerHTML = '<button class="action-link" onclick="copyMsg(this)">复制</button>';
      bubble.parentElement.appendChild(actions);
    }
  }
}

function copyMsg(btn) {
  const text = btn.closest('.msg-body').querySelector('.msg-content').textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = '复制'; }, 1500);
  });
}

function hideWelcome() {
  if (welcomeView) welcomeView.style.display = 'none';
}

function showWelcome() {
  if (welcomeView && messages.length === 0) welcomeView.style.display = 'flex';
}

function scrollBottom() {
  requestAnimationFrame(() => {
    $('editorContainer').scrollTop = $('editorContainer').scrollHeight;
  });
}

async function sendToAPI(userMsg) {
  const settings = getSettings();
  isStreaming = true;

  renderMessage('assistant', '', true);

  try {
    currentController = new AbortController();

    const res = await fetch(`${settings.apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: $('modelTag').textContent,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
        temperature: settings.temperature,
        max_tokens: settings.maxTokens
      }),
      signal: currentController.signal
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;

        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const delta = data.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              updateLastAssistant(fullContent);
              scrollBottom();
            }
          } catch (e) { /* skip malformed */ }
        }
      }
    }

    messages[messages.length - 1].content = fullContent;
    addToHistory(userMsg.substring(0, 30));

  } catch (err) {
    if (err.name !== 'AbortError') {
      updateLastAssistant(`错误: ${err.message}`);
      showToast(err.message, 'error');
    }
  } finally {
    isStreaming = false;
    currentController = null;
    sendBtn.disabled = false;
    input.focus();
  }
}

function startNewChat() {
  messages = [];
  wrapper.innerHTML = '';
  showWelcome();
  $('currentChatLabel').textContent = '新建';
  toggleSidebar();
}

function addToHistory(title) {
  const list = $('chatList');
  const empty = list.querySelector('li');
  if (empty && empty.textContent.includes('暂无对话')) empty.remove();

  const item = document.createElement('li');
  item.className = 'chat-item active';
  item.innerHTML = `<span class="chat-item-icon">💬</span><span>${title}</span>`;
  list.insertBefore(item, list.firstChild);

  $('currentChatLabel').textContent = title;
}

async function testConnection() {
  const settings = getSettings();
  showToast('正在测试连接...', 'info');

  try {
    const res = await fetch(`${settings.apiUrl}/v1/models`, {
      headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}
    });

    if (res.ok) {
      showToast('连接成功', 'success');
      setStatus(true);
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    showToast(`连接失败: ${err.message}`, 'error');
    setStatus(false);
  }
}

function setStatus(ok) {
  const dot = $('statusDot');
  const text = $('statusText');
  dot.className = ok ? 'status-dot' : 'status-dot error';
  text.textContent = ok ? '已连接' : '未连接';
}

function showToast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 150);
  }, 2500);
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  testConnection();
});
