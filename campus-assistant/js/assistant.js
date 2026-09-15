/**
 * AssistantController — Campus AI chat panel.
 *
 * MERGE NOTE: this file is self-contained and safe to drop into your
 * real js/ directory as-is. It talks to POST /api/chat and renders
 * replies as chat bubbles. When a reply includes a locationId, it
 * renders a "Show on map" button that calls your EXISTING
 * `uiController.triggerShowOnMap(locationId, title)` — this file does
 * not reimplement that, it only calls it.
 *
 * Wire-up (in your real js/app.js init sequence):
 *   const assistant = new AssistantController({ uiController });
 *   assistant.init();
 */
class AssistantController {
  constructor({ uiController } = {}) {
    this.uiController = uiController || window.uiController || null;
    this.panel = null;
    this.messagesEl = null;
    this.inputEl = null;
    this.formEl = null;
    this.sending = false;
  }

  init() {
    this._render();
    this._bindEvents();
  }

  _render() {
    const panel = document.createElement('div');
    panel.className = 'assistant-panel';
    panel.innerHTML = `
      <div class="assistant-header">
        <span class="assistant-title">Campus Assistant</span>
        <button type="button" class="assistant-close" aria-label="Close assistant">&times;</button>
      </div>
      <div class="assistant-messages" role="log" aria-live="polite"></div>
      <form class="assistant-input-row">
        <input
          type="text"
          class="assistant-input"
          placeholder="Ask about a block, hostel, office…"
          autocomplete="off"
        />
        <button type="submit" class="assistant-send" aria-label="Send">Send</button>
      </form>
    `;
    document.body.appendChild(panel);
    this.panel = panel;
    this.messagesEl = panel.querySelector('.assistant-messages');
    this.inputEl = panel.querySelector('.assistant-input');
    this.formEl = panel.querySelector('.assistant-input-row');

    panel.querySelector('.assistant-close').addEventListener('click', () => {
      panel.classList.add('assistant-panel--hidden');
    });

    this._addBotMessage(
      'Hi! Ask me about buildings, hostels, food, offices, or departments on campus.'
    );
  }

  _bindEvents() {
    this.formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.inputEl.value.trim();
      if (!text || this.sending) return;
      this._addUserMessage(text);
      this.inputEl.value = '';
      this._sendMessage(text);
    });
  }

  async _sendMessage(message) {
    this.sending = true;
    const typingEl = this._addBotMessage('…', { typing: true });
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      typingEl.remove();
      this._addBotMessage(data.reply, {
        locationId: data.locationId,
        title: data.title,
      });
    } catch (err) {
      typingEl.remove();
      this._addBotMessage('Something went wrong reaching the assistant. Please try again.');
      console.error('[AssistantController] chat request failed:', err);
    } finally {
      this.sending = false;
    }
  }

  _addUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'assistant-msg assistant-msg--user';
    el.textContent = text;
    this.messagesEl.appendChild(el);
    this._scrollToBottom();
    return el;
  }

  _addBotMessage(text, { locationId = null, title = null, typing = false } = {}) {
    const el = document.createElement('div');
    el.className = 'assistant-msg assistant-msg--bot';
    if (typing) el.classList.add('assistant-msg--typing');

    const textEl = document.createElement('div');
    textEl.className = 'assistant-msg-text';
    textEl.textContent = text;
    el.appendChild(textEl);

    if (locationId) {
      const btn = document.createElement('button');
      btn.className = 'assistant-map-btn';
      btn.type = 'button';
      btn.textContent = 'Show on map';
      btn.addEventListener('click', () => {
        if (this.uiController && typeof this.uiController.triggerShowOnMap === 'function') {
          this.uiController.triggerShowOnMap(locationId, title);
        } else {
          console.warn(
            '[AssistantController] uiController.triggerShowOnMap not found — ' +
              'pass a real uiController when constructing AssistantController.'
          );
        }
      });
      el.appendChild(btn);
    }

    this.messagesEl.appendChild(el);
    this._scrollToBottom();
    return el;
  }

  _scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}

if (typeof window !== 'undefined') {
  window.AssistantController = AssistantController;
}
