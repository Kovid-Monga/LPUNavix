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
    this.sessionHistory = [];
    this.savedMessages = [];
    this.lastConfirmedEntity = null;
    this.STORAGE_KEY_MESSAGES = 'lpunavix_assistant_chat_messages';
    this.STORAGE_KEY_HISTORY = 'lpunavix_assistant_session_history';
    this.STORAGE_KEY_LAST_ENTITY = 'lpunavix_assistant_last_entity';
  }

  init() {
    this._render();
    this._bindEvents();
  }

  _saveChatState() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(this.STORAGE_KEY_MESSAGES, JSON.stringify(this.savedMessages.slice(-40)));
      localStorage.setItem(this.STORAGE_KEY_HISTORY, JSON.stringify(this.sessionHistory.slice(-10)));
      if (this.lastConfirmedEntity) {
        localStorage.setItem(this.STORAGE_KEY_LAST_ENTITY, JSON.stringify(this.lastConfirmedEntity));
      } else {
        localStorage.removeItem(this.STORAGE_KEY_LAST_ENTITY);
      }
    } catch (e) {
      console.warn('[AssistantController] Failed to save chat state to localStorage:', e);
    }
  }

  _loadChatHistory() {
    try {
      if (typeof localStorage === 'undefined') return false;
      const rawHistory = localStorage.getItem(this.STORAGE_KEY_HISTORY);
      if (rawHistory) {
        this.sessionHistory = JSON.parse(rawHistory) || [];
      }
      const rawEntity = localStorage.getItem(this.STORAGE_KEY_LAST_ENTITY);
      if (rawEntity) {
        this.lastConfirmedEntity = JSON.parse(rawEntity) || null;
      }
      const rawMsgs = localStorage.getItem(this.STORAGE_KEY_MESSAGES);
      if (rawMsgs) {
        const msgs = JSON.parse(rawMsgs);
        if (Array.isArray(msgs) && msgs.length > 0) {
          this.savedMessages = msgs;
          for (const msg of msgs) {
            if (msg.role === 'user') {
              this._addUserMessage(msg.text, false);
            } else if (msg.role === 'bot') {
              this._addBotMessage(msg.text, {
                actions: msg.actions || [],
                suggestions: msg.suggestions || [],
                location_card: msg.location_card || null,
              }, false);
            }
          }
          this._scrollToBottom();
          return true;
        }
      }
    } catch (e) {
      console.warn('[AssistantController] Failed to restore chat state from localStorage:', e);
    }
    return false;
  }

  clearHistory() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(this.STORAGE_KEY_MESSAGES);
        localStorage.removeItem(this.STORAGE_KEY_HISTORY);
        localStorage.removeItem(this.STORAGE_KEY_LAST_ENTITY);
      }
    } catch (e) {
      console.warn('[AssistantController] Failed to clear chat history from localStorage:', e);
    }
    this.sessionHistory = [];
    this.savedMessages = [];
    this.lastConfirmedEntity = null;
    if (this.messagesEl) {
      this.messagesEl.innerHTML = '';
    }
    this._addDefaultGreeting();
  }

  _addDefaultGreeting() {
    this._addBotMessage(
      "Hi there! 😊 I'm your LPUNavix Campus Assistant ✨\n\nAsk me about the Central Library, Placement Cell (TPC), Shanti Devi Mittal Auditorium, faculty cabins, academic departments, blocks, hostels, or campus services!",
      {},
      true
    );
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
        <div class="assistant-header-actions">
          <button type="button" class="assistant-clear-btn" aria-label="Clear chat history" title="Clear chat history">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
          <button type="button" class="assistant-close" aria-label="Close assistant" title="Close assistant">&times;</button>
        </div>
      </div>
      <div class="assistant-messages" role="log" aria-live="polite"></div>
      <form class="assistant-input-row" autocomplete="off" data-lpignore="true" data-form-type="other">
        <input
          type="search"
          name="campus_assistant_message"
          class="assistant-input"
          placeholder="Ask about central library, placement cell, faculty cabins, blocks…"
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

    const clearBtn = panel.querySelector('.assistant-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.clearHistory();
      });
    }

    const hasRestored = this._loadChatHistory();
    if (!hasRestored) {
      this._addDefaultGreeting();
    }
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

    // Track user message in session history (rolling last 10 turns)
    this.sessionHistory.push({ role: 'user', content: message });
    if (this.sessionHistory.length > 10) {
      this.sessionHistory = this.sessionHistory.slice(-10);
    }
    this._saveChatState();

    // Live GPS telemetry (if consented & available)
    let user_location = null;
    if (window.CampusMap && window.CampusMap.currentUserCoords) {
      user_location = {
        lat: window.CampusMap.currentUserCoords[0],
        lng: window.CampusMap.currentUserCoords[1],
        accuracy_m: window.CampusMap.currentUserAccuracy || 10.0,
        consented: true
      };
    }

    try {
      // Call Autonomous Agent endpoint with fallback
      let res;
      const headers = {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
      };
      try {
        res = await fetch('/api/agent/chat', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            message,
            history: this.sessionHistory,
            last_entity: this.lastConfirmedEntity,
            user_location,
          }),
        });
      } catch (netErr) {
        console.warn('[AssistantController] Primary endpoint network error:', netErr);
      }

      // If primary endpoint failed or returned non-200, retry via fallback
      if (!res || !res.ok) {
        try {
          res = await fetch('/api/chat', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              message,
              history: this.sessionHistory,
              last_entity: this.lastConfirmedEntity,
            }),
          });
        } catch (fallbackErr) {
          console.error('[AssistantController] Fallback request failed:', fallbackErr);
        }
      }

      if (!res || !res.ok) {
        const status = res ? res.status : 'offline';
        throw new Error(`Request failed (${status})`);
      }
      const data = await res.json();
      typingEl.remove();

      // Track confirmed entity from response
      if (data.last_entity) {
        this.lastConfirmedEntity = data.last_entity;
      } else if (data.locationId) {
        this.lastConfirmedEntity = {
          id: data.locationId,
          name: data.title || data.locationId,
        };
      }

      // Track assistant reply in session history
      if (data.reply) {
        this.sessionHistory.push({ role: 'assistant', content: data.reply });
        if (this.sessionHistory.length > 10) {
          this.sessionHistory = this.sessionHistory.slice(-10);
        }
        this._saveChatState();
      }

      // Only execute actions that explicitly requested hands-free auto_execute
      const autoActions = (data.actions || []).filter(a => a.auto_execute);
      if (autoActions.length > 0) {
        this._dispatchActions(autoActions);
      }

      this._addBotMessage(data.reply, {
        actions: data.actions || [],
        suggestions: data.suggestions || [],
        location_card: data.location_card || null,
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

  selectLocationOnMap(destName, coordinates, locationCard = null) {
    // 1. Hide the assistant panel so the user can see the campus map and details card clearly
    if (this.uiController && typeof this.uiController.toggleAssistant === 'function') {
      this.uiController.toggleAssistant(false);
    }

    const allLocs = (typeof getAllCampusLocations === 'function') ? getAllCampusLocations() : (window.CAMPUS_LOCATIONS || []);
    const cleanDest = (destName || '').trim().toLowerCase();

    // 2. Find exact or partial location match in campus dataset
    let matched = allLocs.find(l => {
      const name = (l.name || '').toLowerCase();
      const id = (l.id || '').toLowerCase();
      return name === cleanDest || id === cleanDest ||
             (cleanDest.length > 2 && (name.includes(cleanDest) || cleanDest.includes(name)));
    });

    if (!matched && coordinates && coordinates.length === 2) {
      // Find nearest location to coordinates
      matched = allLocs.find(l => {
        if (l.lat && l.lng) {
          const dLat = Math.abs(l.lat - coordinates[0]);
          const dLng = Math.abs(l.lng - coordinates[1]);
          return dLat < 0.0006 && dLng < 0.0006;
        }
        return false;
      });
    }

    if (!matched) {
      matched = {
        id: 'loc-' + (destName || 'campus').replace(/[^a-z0-9]/gi, '-').toLowerCase(),
        name: destName || (locationCard ? locationCard.title : 'Campus Location'),
        lat: coordinates ? coordinates[0] : 31.2538,
        lng: coordinates ? coordinates[1] : 75.7045,
        desc: (locationCard && locationCard.subtitle) || 'Campus Facility',
        facilities: locationCard && locationCard.category ? [locationCard.category.toUpperCase()] : ['CAMPUS FACILITY'],
        hours: (locationCard && locationCard.hours) || 'Open on Campus Schedule'
      };
    }

    // 3. Trigger showLocationDetails to reveal the pin and display the bottom card
    if (window.UIController && typeof window.UIController.showLocationDetails === 'function') {
      window.UIController.showLocationDetails(matched, false, 'minimized');
    }

    // 4. Center map camera with 3D pitch and focus
    if (coordinates && coordinates.length === 2 && window.CampusMap && window.CampusMap.map) {
      window.CampusMap.map.flyTo({
        center: [coordinates[1], coordinates[0]],
        zoom: 17.5,
        pitch: 45,
        essential: true,
      });
      if (matched && matched.id && typeof window.CampusMap.revealLocation === 'function') {
        window.CampusMap.revealLocation(matched.id);
      }
    }
  }

  _dispatchActions(actions) {
    if (!actions || !Array.isArray(actions)) return;

    for (const action of actions) {
      try {
        if (action.action_type === 'FLY_TO_LOCATION' || action.action_type === 'SET_MAP_VIEW') {
          const destName = action.label || 'Campus Location';
          setTimeout(() => {
            this.selectLocationOnMap(destName, action.coordinates);
          }, 450);
        } else if (action.action_type === 'SET_DIRECTIONS') {
          const destName = (action.end && action.end.label) || action.label;
          const originName = (action.start && action.start.label) || null;
          const stops = action.stops || [];
          if (destName && this.uiController && typeof this.uiController.triggerShowOnMap === 'function') {
            // Small delay to allow message to render before panel toggles
            setTimeout(() => {
              this.uiController.triggerShowOnMap(destName, originName, stops);
            }, 600);
          }
        }
      } catch (err) {
        console.warn('[AssistantController] Failed to dispatch action:', action, err);
      }
    }
  }

  _addUserMessage(text, save = true) {
    const el = document.createElement('div');
    el.className = 'assistant-msg assistant-msg--user';
    el.textContent = text;
    this.messagesEl.appendChild(el);
    this._scrollToBottom();

    if (save) {
      this.savedMessages.push({
        role: 'user',
        text: text,
        timestamp: Date.now()
      });
      if (this.savedMessages.length > 40) {
        this.savedMessages = this.savedMessages.slice(-40);
      }
      this._saveChatState();
    }
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

  _sanitizeReplyText(text) {
    if (!text) return '';
    let cleaned = text.replace(/\r\n/g, '\n');
    // Strip any follow-up questions or headers that may have leaked into the text body
    const cutPatterns = [
      /(?:^|\b|\n)(?:suggested\s+)?(?:follow[\-\s]?up\s*)?questions?[:\s\-].*$/is,
      /(?:^|\b|\n)(?:q1|q\.1|question\s*1|\[q1\])\s*[:\-\)].*$/is,
      /(?:^|\b|\n)1[\.\)]\s+.+?\?\s*2[\.\)].*$/is
    ];
    for (const pat of cutPatterns) {
      cleaned = cleaned.replace(pat, '');
    }
    // Remove leading REPLY: or Assistant: prefixes if present
    cleaned = cleaned.replace(/^(?:reply|assistant|response|answer)\b[:\s\-]*/i, '');
    return cleaned.trim();
  }

  _formatResponseHtml(rawText) {
    if (!rawText) return '';
    const cleanedText = this._sanitizeReplyText(rawText);
    if (!cleanedText) return '';
    const normalized = cleanedText.trim();
    // Split into standard paragraphs
    const paragraphs = normalized.split(/(?:\n\s*\n)+/);
    const htmlParas = [];

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      const lines = trimmed.split('\n').map((l) => this._formatInline(l.trim())).filter(Boolean);
      htmlParas.push(`<p class="assistant-msg-para">${lines.join('<br>')}</p>`);
    }

    return htmlParas.join('');
  }

  _createActionButtons(actions) {
    if (!Array.isArray(actions) || actions.length === 0) return null;
    const actionsEl = document.createElement('div');
    actionsEl.className = 'assistant-actions';

    for (const act of actions) {
      if (act.action_type === 'SET_DIRECTIONS') {
        const dest = (act.end && act.end.label) || act.label || 'Destination';
        const origin = (act.start && act.start.label) || null;
        const stops = act.stops || [];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'assistant-action-btn assistant-action-btn--directions';
        btn.innerHTML = `🧭 <strong>Get Directions</strong>`;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.uiController && typeof this.uiController.triggerShowOnMap === 'function') {
            this.uiController.triggerShowOnMap(dest, origin, stops);
          }
        });
        actionsEl.appendChild(btn);
      } else if (act.action_type === 'FLY_TO_LOCATION') {
        const dest = act.label || 'Campus Location';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'assistant-action-btn assistant-action-btn--fly';
        btn.innerHTML = `📍 <strong>View on Map</strong>`;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.selectLocationOnMap(dest, act.coordinates);
        });
        actionsEl.appendChild(btn);
      }
    }

    return actionsEl.children.length > 0 ? actionsEl : null;
  }

  _addBotMessage(text, { actions = [], suggestions = [], location_card = null } = {}, save = true) {
    const el = document.createElement('div');
    el.className = 'assistant-msg assistant-msg--bot';

    // 1. Normal Conversational Text (Plain, readable chat font)
    const textEl = document.createElement('div');
    textEl.className = 'assistant-msg-text';
    textEl.innerHTML = this._formatResponseHtml(text);
    el.appendChild(textEl);

    // 2. Dedicated Location Card (ONLY location details appear in a card)
    if (location_card && location_card.title) {
      const cardEl = document.createElement('div');
      cardEl.className = 'assistant-location-card';

      let icon = '📍';
      const cat = (location_card.category || '').toLowerCase();
      let tagText = location_card.category ? location_card.category.toUpperCase() : 'CAMPUS';
      if (cat.includes('study') || cat.includes('library')) { icon = '📚'; tagText = 'LIBRARY'; }
      else if (cat.includes('food') || cat.includes('canteen') || cat.includes('mall')) { icon = '🍔'; tagText = 'DINING'; }
      else if (cat.includes('health') || cat.includes('doctor')) { icon = '🏥'; tagText = 'HEALTH'; }
      else if (cat.includes('finance') || cat.includes('atm')) { icon = '🏧'; tagText = 'ATM'; }
      else if (cat.includes('stationery') || cat.includes('print')) { icon = '🖨️'; tagText = 'PRINT'; }
      else if (cat.includes('faculty') || cat.includes('hod')) { icon = '👨‍🏫'; tagText = 'FACULTY'; }
      else if (cat.includes('block') || cat.includes('academic')) { icon = '🏛️'; tagText = 'BLOCK'; }
      else if (cat.includes('direction') || cat.includes('route')) { icon = '🧭'; tagText = 'ROUTE'; }
      else if (location_card.subtitle && location_card.subtitle.length <= 16) { tagText = location_card.subtitle; }

      let headerHtml = `
        <div class="assistant-loc-card-header">
          <div class="assistant-loc-card-title">${icon} <strong>${this._escapeHtml(location_card.title)}</strong></div>
          <span class="assistant-loc-card-tag">${this._escapeHtml(tagText)}</span>
        </div>
      `;

      let detailsHtml = '<div class="assistant-loc-card-details">';
      if (location_card.subtitle && tagText !== location_card.subtitle) {
        detailsHtml += `
          <div class="assistant-loc-card-row" style="font-weight: 600; color: var(--color-primary, #2563eb);">
            <span class="assistant-loc-text">${this._escapeHtml(location_card.subtitle)}</span>
          </div>
        `;
      }
      if (location_card.location) {
        detailsHtml += `
          <div class="assistant-loc-card-row">
            <span class="assistant-loc-icon">📍</span>
            <span class="assistant-loc-text">${this._escapeHtml(location_card.location)}</span>
            ${location_card.code ? `<span class="assistant-loc-badge">${this._escapeHtml(location_card.code)}</span>` : ''}
          </div>
        `;
      }
      if (location_card.hours) {
        detailsHtml += `
          <div class="assistant-loc-card-row">
            <span class="assistant-loc-icon">🕒</span>
            <span class="assistant-loc-text">${this._escapeHtml(location_card.hours)}</span>
          </div>
        `;
      }
      detailsHtml += '</div>';

      cardEl.innerHTML = headerHtml + detailsHtml;

      // Attach map and directions action buttons directly inside the location card
      if (Array.isArray(actions) && actions.length > 0) {
        const actionsEl = this._createActionButtons(actions);
        if (actionsEl) {
          cardEl.appendChild(actionsEl);
        }
      }

      el.appendChild(cardEl);
    } else if (Array.isArray(actions) && actions.length > 0) {
      // Standalone actions without explicit location card
      const actionsEl = this._createActionButtons(actions);
      if (actionsEl) {
        el.appendChild(actionsEl);
      }
    }

    // 3. Exactly 2 Follow-up Questions Generated According to Chat
    if (Array.isArray(suggestions) && suggestions.length > 0) {
      const followups = suggestions.slice(0, 2);
      const containerEl = document.createElement('div');
      containerEl.className = 'assistant-followups';

      const titleEl = document.createElement('div');
      titleEl.className = 'assistant-followup-title';
      titleEl.textContent = 'Suggested follow-up:';
      containerEl.appendChild(titleEl);

      for (const q of followups) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'assistant-followup-chip';
        btn.innerHTML = `<span class="assistant-followup-icon">💬</span><span class="assistant-followup-text">${this._escapeHtml(q)}</span>`;
        btn.addEventListener('click', () => {
          this.inputEl.value = q;
          if (this.formEl) {
            this.formEl.dispatchEvent(new Event('submit', { cancelable: true }));
          }
        });
        containerEl.appendChild(btn);
      }
      el.appendChild(containerEl);
    }

    this.messagesEl.appendChild(el);
    this._scrollToBottom();

    if (save) {
      this.savedMessages.push({
        role: 'bot',
        text: text,
        actions: actions || [],
        suggestions: suggestions || [],
        location_card: location_card || null,
        timestamp: Date.now()
      });
      if (this.savedMessages.length > 40) {
        this.savedMessages = this.savedMessages.slice(-40);
      }
      this._saveChatState();
    }

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
