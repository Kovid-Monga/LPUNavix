/**
 * AssistantController — Campus AI chat panel.
 *
 * Provides a friendly, conversational campus assistant experience
 * with rich card layouts, quick actions, and direct integration with
 * `uiController.triggerShowOnMap(locationId, title)`.
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
        <div class="assistant-title-wrap">
          <span class="assistant-title">Campus Assistant</span>
          <span class="assistant-subtitle">LPUNavix AI Guide</span>
        </div>
        <button type="button" class="assistant-close" aria-label="Close assistant" title="Close assistant">&times;</button>
      </div>
      <div class="assistant-messages" role="log" aria-live="polite"></div>
      <form class="assistant-input-row" autocomplete="off" data-lpignore="true" data-form-type="other">
        <input
          type="search"
          name="campus_assistant_message"
          class="assistant-input"
          placeholder="Ask about faculty cabins, blocks, departments…"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          enterkeyhint="send"
          data-lpignore="true"
          data-form-type="other"
        />
        <button type="submit" class="assistant-send" aria-label="Send message">Send</button>
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
      "Hi there! 😊 I'm your LPUNavix Campus Assistant.\n\nAsk me about faculty cabins, academic departments, blocks, hostels, or campus services!",
      {
        chips: [
          'Where is Block 34?',
          'HOD of AI and ML',
          'Who is the HOS?',
          'Uni Health Center',
        ],
      }
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
    const typingEl = this._addTypingIndicator();
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
      this._addBotMessage(
        "Hmm, I couldn't connect to the campus records right now. Please check your network and try again. 📡"
      );
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

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  _formatInline(text) {
    let escaped = this._escapeHtml(text);
    // Convert bold **text** to <strong>text</strong>
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Convert italic *text* to <em>text</em>
    escaped = escaped.replace(/\*([^\*]+?)\*/g, '<em>$1</em>');
    // Convert arrows -> or →
    escaped = escaped.replace(/(?:-&gt;|&rarr;|→)/g, '<span class="assistant-arrow">→</span>');
    // Convert bullet dots ·
    escaped = escaped.replace(/(?:·|&middot;)/g, '<span class="assistant-dot">·</span>');
    return escaped;
  }

  _formatResponseHtml(rawText) {
    if (!rawText) return '';
    const normalized = rawText.replace(/\r\n/g, '\n').trim();

    // Split into logical blocks by double newlines or horizontal dividers
    const rawBlocks = normalized.split(/(?:\n\s*---\s*\n|\n\s*\n)+/);
    const htmlBlocks = [];

    for (const block of rawBlocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      const lines = trimmed
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const firstLine = lines[0] || '';
      const hasCardEmoji = /^(👩‍🏫|🏢|🏛️|📌|👨‍🏫)/.test(firstLine);
      const hasLocationPin = lines.some((l) => l.includes('📍'));

      if (hasCardEmoji || (hasLocationPin && lines.length >= 2)) {
        // Structured information card
        let cardTitleHtml = '';
        const bodyLines = [];
        let locHtml = '';

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (i === 0 && (hasCardEmoji || lines.length > 2)) {
            const titleClean = line.replace(/^\*\*(.*?)\*\*$/, '$1');
            cardTitleHtml = `<div class="assistant-card-header">${this._formatInline(titleClean)}</div>`;
          } else if (line.startsWith('📍')) {
            const locText = line.replace(/^📍\s*/, '').trim();
            locHtml = `<div class="assistant-card-loc"><span class="assistant-loc-icon">📍</span><span class="assistant-loc-text">${this._formatInline(locText)}</span></div>`;
          } else {
            bodyLines.push(`<div class="assistant-card-meta">${this._formatInline(line)}</div>`);
          }
        }

        htmlBlocks.push(`
          <div class="assistant-card">
            ${cardTitleHtml}
            ${bodyLines.length > 0 ? `<div class="assistant-card-body">${bodyLines.join('')}</div>` : ''}
            ${locHtml}
          </div>
        `);
      } else if (
        /^(would you like|do you want|anything else|can i help|is there anything)/i.test(trimmed) ||
        (trimmed.endsWith('?') && lines.length === 1)
      ) {
        htmlBlocks.push(`<p class="assistant-msg-followup">${this._formatInline(trimmed)}</p>`);
      } else {
        const formattedPara = lines.map((l) => this._formatInline(l)).join('<br>');
        htmlBlocks.push(`<p class="assistant-msg-para">${formattedPara}</p>`);
      }
    }

    return htmlBlocks.join('');
  }

  _addBotMessage(text, { locationId = null, title = null, chips = null } = {}) {
    const el = document.createElement('div');
    el.className = 'assistant-msg assistant-msg--bot';

    const textEl = document.createElement('div');
    textEl.className = 'assistant-msg-text';
    textEl.innerHTML = this._formatResponseHtml(text);
    el.appendChild(textEl);

    // Context-sensitive Action Buttons
    if (locationId) {
      const actionsEl = document.createElement('div');
      actionsEl.className = 'assistant-actions';

      const mapBtn = document.createElement('button');
      mapBtn.className = 'assistant-action-btn assistant-map-btn';
      mapBtn.type = 'button';
      mapBtn.innerHTML = '<span>🗺️ Show on Map</span>';
      mapBtn.title = 'View location and directions on campus map';
      mapBtn.addEventListener('click', () => {
        if (this.uiController && typeof this.uiController.triggerShowOnMap === 'function') {
          this.uiController.triggerShowOnMap(locationId, title);
        } else {
          console.warn(
            '[AssistantController] uiController.triggerShowOnMap not found — ' +
              'pass a real uiController when constructing AssistantController.'
          );
        }
      });
      actionsEl.appendChild(mapBtn);

      const askBtn = document.createElement('button');
      askBtn.className = 'assistant-action-btn assistant-ask-btn';
      askBtn.type = 'button';
      askBtn.innerHTML = '<span>🔍 Ask Another Query</span>';
      askBtn.addEventListener('click', () => {
        if (this.inputEl) {
          this.inputEl.focus();
          this.inputEl.select();
        }
      });
      actionsEl.appendChild(askBtn);

      el.appendChild(actionsEl);
    }

    // Quick suggestion prompt chips
    if (chips && Array.isArray(chips) && chips.length > 0) {
      const chipsEl = document.createElement('div');
      chipsEl.className = 'assistant-chips';
      chips.forEach((query) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'assistant-chip';
        chip.textContent = query;
        chip.addEventListener('click', () => {
          if (this.sending) return;
          this._addUserMessage(query);
          this._sendMessage(query);
        });
        chipsEl.appendChild(chip);
      });
      el.appendChild(chipsEl);
    }

    this.messagesEl.appendChild(el);
    this._scrollToBottom();
    return el;
  }

  _addTypingIndicator() {
    const el = document.createElement('div');
    el.className = 'assistant-msg assistant-msg--bot assistant-msg--typing';
    el.innerHTML = `
      <div class="assistant-typing-container">
        <span class="assistant-typing-label">Checking campus records...</span>
        <span class="assistant-typing-dots">
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
          <span class="typing-dot"></span>
        </span>
      </div>
    `;
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
