/**
 * LPU Map - AI Assistant Chat Controller (Panel 3 - RAG Assistant)
 * Manages conversational queries, fast responses, rich card embeds, and map triggers.
 */

class AssistantController {
  constructor() {
    this.messages = [];
  }

  init() {
    this.bindEvents();
    // Render initial sample welcome flow
    this.renderInitialChat();
  }

  bindEvents() {
    const sendBtn = document.getElementById("send-chat-btn");
    const inputField = document.getElementById("chat-input-field");

    if (sendBtn && inputField) {
      sendBtn.addEventListener("click", () => this.handleSendMessage());
      inputField.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.handleSendMessage();
      });
    }

    // Quick prompt chips
    const promptChips = document.querySelectorAll(".prompt-chip-btn");
    promptChips.forEach(chip => {
      chip.addEventListener("click", (e) => {
        const text = e.currentTarget.textContent.trim();
        this.submitPrompt(text);
      });
    });
  }

  renderInitialChat() {
    const chatStream = document.getElementById("chat-messages-stream");
    if (!chatStream) return;

    chatStream.innerHTML = "";

    // Welcome Assistant bubble
    this.appendMessage({
      sender: "assistant",
      text: "Hello! I am your **LPUNavix AI Assistant**. Ask me anything about campus locations, blocks, and directions!"
    });
  }

  handleSendMessage() {
    const inputField = document.getElementById("chat-input-field");
    if (!inputField) return;

    const text = inputField.value.trim();
    if (!text) return;

    inputField.value = "";
    this.submitPrompt(text);
  }

  formatMarkdown(text) {
    if (!text) return "";
    let html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    // Bold: **text**
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Italics: *text*
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    // Bullet lines (e.g. • or - or *)
    html = html.replace(/^[\s]*[•\-\*]\s+(.*)$/gm, '<li style="margin-bottom:4px;">$1</li>');
    // Wrap lists if <li> exists
    if (html.includes('<li')) {
      html = html.replace(/(<li[\s\S]*?<\/li>)/g, '<ul style="padding-left:18px;margin:6px 0;">$1</ul>');
      // Clean up adjacent </ul><ul>
      html = html.replace(/<\/ul>\s*<ul style="padding-left:18px;margin:6px 0;">/g, '');
    }
    // Newlines to <br/>
    html = html.replace(/\n/g, '<br/>');
    return html;
  }

  async submitPrompt(queryText) {
    this.appendMessage({ sender: "user", text: queryText });

    const assistantBubble = this.appendMessage({
      sender: "assistant",
      text: "Checking campus records..."
    });

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: queryText })
      });

      const data = await response.json();
      const reply = data && data.reply ? data.reply : "I couldn’t find a reliable answer in the campus records.";
      const locationId = data && data.locationId ? data.locationId : null;
      const title = data && data.title ? data.title : null;

      const chatStream = document.getElementById("chat-messages-stream");
      if (chatStream) {
        const lastBubble = chatStream.querySelector(".chat-bubble-row.assistant:last-child .chat-bubble");
        if (lastBubble) {
          const formattedHtml = this.formatMarkdown(reply);
          let cardHtml = "";
          if (locationId || title) {
            const safeLocId = (locationId || "").replace(/'/g, "\\'");
            const safeTitle = (title || "").replace(/'/g, "\\'");
            cardHtml = `
              <div class="ai-map-preview-card" style="margin-top:10px;">
                <div class="ai-map-action-bar">
                  <div style="display:flex;flex-direction:column;gap:2px;">
                    <span style="font-size:12px;font-weight:700;color:var(--text-primary);">${title || "Campus Location"}</span>
                    <span style="font-size:10px;color:var(--text-muted);">Get dotted route & live ETAs</span>
                  </div>
                  <button class="btn-show-map" onclick="window.UIController && window.UIController.triggerShowOnMap ? window.UIController.triggerShowOnMap('${safeLocId}', '${safeTitle}') : null">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="3 11 22 2 13 21 11 13 3 11"></polygon></svg>
                    Show on Map
                  </button>
                </div>
              </div>
            `;
          }
          lastBubble.innerHTML = `<div>${formattedHtml}</div>${cardHtml}`;
        }
      }
    } catch (error) {
      // Client-side fallback if backend server is unreachable
      const localMatch = this.findMatchingAnswer(queryText);
      const chatStream = document.getElementById("chat-messages-stream");
      if (chatStream) {
        const lastBubble = chatStream.querySelector(".chat-bubble-row.assistant:last-child .chat-bubble");
        if (lastBubble) {
          if (localMatch) {
            const reply = localMatch.answer || `**${localMatch.title || "Campus Location"}**: ${localMatch.desc || ""}`;
            const locId = localMatch.locationId || null;
            const title = localMatch.title || null;
            const formattedHtml = this.formatMarkdown(reply);
            const safeLocId = (locId || "").replace(/'/g, "\\'");
            const safeTitle = (title || "").replace(/'/g, "\\'");
            const cardHtml = (locId || title) ? `
              <div class="ai-map-preview-card" style="margin-top:10px;">
                <div class="ai-map-action-bar">
                  <div style="display:flex;flex-direction:column;gap:2px;">
                    <span style="font-size:12px;font-weight:700;color:var(--text-primary);">${title || "Campus Location"}</span>
                    <span style="font-size:10px;color:var(--text-muted);">Get dotted route & live ETAs</span>
                  </div>
                  <button class="btn-show-map" onclick="window.UIController && window.UIController.triggerShowOnMap ? window.UIController.triggerShowOnMap('${safeLocId}', '${safeTitle}') : null">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="3 11 22 2 13 21 11 13 3 11"></polygon></svg>
                    Show on Map
                  </button>
                </div>
              </div>` : "";
            lastBubble.innerHTML = `<div>${formattedHtml}</div>${cardHtml}`;
          } else {
            lastBubble.innerHTML = `<div>I’m unable to reach the campus assistant backend right now. Please make sure the Python server is running (<code>uvicorn api.main:app --port 8000</code>).</div>`;
          }
        }
      }
    }
  }

  findMatchingAnswer(query) {
    const qLower = query.toLowerCase();

    // 1. Direct Knowledge Base matches
    if (Array.isArray(AI_KNOWLEDGE_BASE) && AI_KNOWLEDGE_BASE.length > 0) {
      const kbMatch = AI_KNOWLEDGE_BASE.find(item => 
        (Array.isArray(item.triggers) && item.triggers.some(t => qLower.includes(t.toLowerCase()))) || 
        (item.question && qLower.includes(item.question.toLowerCase()))
      );
      if (kbMatch) return kbMatch;
    }

    // 2. Dynamic Match in CAMPUS_GROUPS (Departments, Food Courts, Hostels)
    if (Array.isArray(CAMPUS_GROUPS)) {
      const groupMatch = CAMPUS_GROUPS.find(g => 
        g.name.toLowerCase().includes(qLower) || 
        (Array.isArray(g.tags) && g.tags.some(t => qLower.includes(t.toLowerCase())))
      );
      if (groupMatch) {
        const memberList = groupMatch.blocks 
          ? `Blocks: **${groupMatch.blocks.map(b => b.replace('block-', 'Block ')).join(', ')}**`
          : (groupMatch.shops ? `Outlets: **${groupMatch.shops.join(', ')}**` : "");

        return {
          answer: `**${groupMatch.name}** is located in the campus ${groupMatch.type}. ${memberList}. ${groupMatch.desc || ""}`,
          locationId: groupMatch.id,
          title: groupMatch.name
        };
      }
    }

    // 3. Dynamic Match in CAMPUS_LOCATIONS (Individual Blocks, Shops, Labs)
    if (typeof getAllCampusLocations === "function") {
      const locMatch = getAllCampusLocations().find(loc => 
        loc.name.toLowerCase().includes(qLower) || 
        (Array.isArray(loc.tags) && loc.tags.some(t => qLower.includes(t.toLowerCase()))) ||
        (Array.isArray(loc.facilities) && loc.facilities.some(f => qLower.includes(f.toLowerCase())))
      );
      if (locMatch) {
        const parentInfo = locMatch.groupName ? ` (Part of **${locMatch.groupName}**)` : "";
        return {
          answer: `**${locMatch.name}**${parentInfo} is located at **${locMatch.floor || "Campus"}**. ${locMatch.desc || ""}`,
          locationId: locMatch.id,
          title: locMatch.name
        };
      }
    }

    return null;
  }

  appendMessage({ sender, text, hasMapAction = false, locationId = null, title = null }) {
    const chatStream = document.getElementById("chat-messages-stream");
    if (!chatStream) return;

    const row = document.createElement("div");
    row.className = `chat-bubble-row ${sender}`;

    // Convert basic markdown bold **text** to <strong>
    const formattedText = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br/>');

    let contentHtml = "";

    if (sender === "assistant") {
      const safeLocId = (locationId || "").replace(/'/g, "\\'");
      const safeTitle = (title || "").replace(/'/g, "\\'");
      contentHtml = `
        <div class="ai-avatar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8.01" y2="16"></line><line x1="16" y1="16" x2="16.01" y2="16"></line></svg>
        </div>
        <div class="chat-bubble">
          <div>${formattedText}</div>
          ${(hasMapAction || locationId || title) ? `
            <div class="ai-map-preview-card" style="margin-top:10px;">
              <div class="ai-map-action-bar">
                <div style="display:flex;flex-direction:column;gap:2px;">
                  <span style="font-size:12px;font-weight:700;color:var(--text-primary);">${title || "Campus Location"}</span>
                  <span style="font-size:10px;color:var(--text-muted);">Get dotted route & live ETAs</span>
                </div>
                <button class="btn-show-map" onclick="window.UIController && window.UIController.triggerShowOnMap ? window.UIController.triggerShowOnMap('${safeLocId}', '${safeTitle}') : null">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="3 11 22 2 13 21 11 13 3 11"></polygon></svg>
                  Show on Map
                </button>
              </div>
            </div>
          ` : ""}
        </div>
      `;
    } else {
      contentHtml = `
        <div class="chat-bubble">
          <div>${formattedText}</div>
        </div>
      `;
    }

    row.innerHTML = contentHtml;
    chatStream.appendChild(row);
    chatStream.scrollTop = chatStream.scrollHeight;
  }
}

// Global Assistant instance
window.Assistant = new AssistantController();
