/* ============================================
   WhoPaid - Receipt Splitter App
   ============================================ */

(function () {
    'use strict';

    // ---- STATE ----
    const state = {
        images: [],        // { file, url }
        items: [],         // { id, name, price, taxCode, qty }
        people: [],        // { id, name, color }
        assignments: {},   // itemId -> [personId, ...]
        taxRate: 20,       // default UK VAT
        hasTaxCodes: false,
        serviceCharge: null,
    };

    let itemIdCounter = 0;
    let personIdCounter = 0;

    const PERSON_COLORS = [
        '#d4380d', '#1890ff', '#389e0d', '#722ed1',
        '#eb2f96', '#fa8c16', '#13c2c2', '#595959',
    ];

    const STORAGE_KEY = 'whopaid_gemini_api_key';

    // ---- DOM REFS ----
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const els = {
        uploadArea: $('#uploadArea'),
        receiptInput: $('#receiptInput'),
        imagePreviewContainer: $('#imagePreviewContainer'),
        processBtn: $('#processBtn'),
        ocrProgress: $('#ocrProgress'),
        progressFill: $('#progressFill'),
        progressText: $('#progressText'),
        itemsList: $('#itemsList'),
        addItemBtn: $('#addItemBtn'),
        taxRateInput: $('#taxRateInput'),
        taxRateBar: $('#taxRateBar'),
        itemsStepDesc: $('#itemsStepDesc'),
        subtotalDisplay: $('#subtotalDisplay'),
        taxDisplay: $('#taxDisplay'),
        totalDisplay: $('#totalDisplay'),
        personNameInput: $('#personNameInput'),
        addPersonBtn: $('#addPersonBtn'),
        peopleTags: $('#peopleTags'),
        assignList: $('#assignList'),
        summaryContent: $('#summaryContent'),
        // Navigation
        backToUpload: $('#backToUpload'),
        toAssign: $('#toAssign'),
        backToItems: $('#backToItems'),
        toSummary: $('#toSummary'),
        backToAssign: $('#backToAssign'),
        startOver: $('#startOver'),
        // Settings
        settingsBtn: $('#settingsBtn'),
        settingsModal: $('#settingsModal'),
        apiKeyInput: $('#apiKeyInput'),
        toggleKeyVisibility: $('#toggleKeyVisibility'),
        saveSettings: $('#saveSettings'),
        closeSettings: $('#closeSettings'),
            };

    // ---- SETTINGS ----
    function getApiKey() {
        return localStorage.getItem(STORAGE_KEY) || '';
    }

    function setApiKey(key) {
        if (key) {
            localStorage.setItem(STORAGE_KEY, key);
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
        updateSettingsButtonState();
    }

    function updateSettingsButtonState() {
        if (getApiKey()) {
            els.settingsBtn.classList.add('has-key');
            els.settingsBtn.title = 'Settings (API key configured)';
        } else {
            els.settingsBtn.classList.remove('has-key');
            els.settingsBtn.title = 'Settings';
        }
    }

    function openSettings() {
        els.apiKeyInput.value = getApiKey();
        els.settingsModal.classList.remove('hidden');
    }

    function closeSettings() {
        els.settingsModal.classList.add('hidden');
    }

    els.settingsBtn.addEventListener('click', openSettings);
    els.closeSettings.addEventListener('click', closeSettings);
    els.settingsModal.querySelector('.modal-backdrop').addEventListener('click', closeSettings);

    els.saveSettings.addEventListener('click', () => {
        setApiKey(els.apiKeyInput.value.trim());
        closeSettings();
    });

    els.toggleKeyVisibility.addEventListener('click', () => {
        const input = els.apiKeyInput;
        if (input.type === 'password') {
            input.type = 'text';
        } else {
            input.type = 'password';
        }
    });

    // Initialize settings button state
    updateSettingsButtonState();

    // ---- NAVIGATION ----
    function showStep(stepId) {
        $$('.step').forEach((s) => s.classList.remove('active'));
        $$('.step').forEach((s) => s.classList.add('hidden'));
        const step = $(`#${stepId}`);
        step.classList.remove('hidden');
        step.classList.add('active');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // ---- IMAGE HANDLING ----
    els.receiptInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        files.forEach((file) => {
            const url = URL.createObjectURL(file);
            state.images.push({ file, url });
        });
        renderImagePreviews();
        els.processBtn.classList.remove('hidden');
        els.processBtn.disabled = state.images.length === 0;
    });

    function renderImagePreviews() {
        els.imagePreviewContainer.innerHTML = '';
        if (state.images.length === 0) {
            els.imagePreviewContainer.classList.add('hidden');
            els.processBtn.classList.add('hidden');
            return;
        }
        els.imagePreviewContainer.classList.remove('hidden');
        state.images.forEach((img, idx) => {
            const div = document.createElement('div');
            div.className = 'image-preview';
            div.innerHTML = `
                <img src="${img.url}" alt="Receipt ${idx + 1}">
                <button class="remove-img" data-idx="${idx}">&times;</button>
            `;
            els.imagePreviewContainer.appendChild(div);
        });

        els.imagePreviewContainer.querySelectorAll('.remove-img').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.idx);
                URL.revokeObjectURL(state.images[idx].url);
                state.images.splice(idx, 1);
                renderImagePreviews();
                els.processBtn.disabled = state.images.length === 0;
            });
        });
    }

    // ---- GEMINI API ----
    async function listGeminiModels(apiKey) {
        try {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
            );
            const data = await response.json();
            console.log('Available Gemini models:', data);

            // Filter for models that support generateContent
            const generateModels = data.models?.filter(m =>
                m.supportedGenerationMethods?.includes('generateContent')
            ) || [];
            console.log('Models supporting generateContent:', generateModels.map(m => m.name));

            return generateModels;
        } catch (err) {
            console.error('Failed to list models:', err);
            return [];
        }
    }

    async function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                // Remove the data URL prefix to get just the base64 data
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    async function extractItemsWithGemini(imageFile, apiKey) {
        const base64Data = await fileToBase64(imageFile);
        const mimeType = imageFile.type || 'image/jpeg';

        const prompt = `You are a receipt parser. Analyze this receipt image and extract all purchased items.

Return a JSON object with this exact format:
{
  "hasTaxCodes": true,
  "serviceCharge": null,
  "items": [
    { "name": "PRODUCT NAME", "price": 12.99, "taxCode": "A" }
  ]
}

Fields:
- hasTaxCodes: true if receipt shows tax codes (like A/Z on Costco receipts), false otherwise
- serviceCharge: if this is a restaurant receipt with a service charge/gratuity, include the amount as a number. Otherwise null
- items: array of purchased items
  - name: Product name (max 60 characters)
  - price: Line total as a number (not unit price - use the final amount)
  - taxCode: "A" for taxed, "Z" for non-taxed. Only include if hasTaxCodes is true

Important:
- Extract ONLY purchased items
- EXCLUDE voided/refunded items
- EXCLUDE totals, subtotals, tax lines, payment methods, change, headers, dates, addresses
- EXCLUDE section headers like "Bottom of Basket", "BOB Count", etc.
- If an item appears multiple times, include each as a separate entry
- Return ONLY the JSON object - no markdown fences, no explanation

If you cannot read any items, return: { "hasTaxCodes": false, "serviceCharge": null, "items": [] }`;

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    contents: [
                        {
                            parts: [
                                { text: prompt },
                                {
                                    inline_data: {
                                        mime_type: mimeType,
                                        data: base64Data,
                                    },
                                },
                            ],
                        },
                    ],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 4096,
                    },
                }),
            }
        );

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            if (response.status === 400 && error.error?.message?.includes('API key')) {
                throw new Error('Invalid API key. Please check your Gemini API key in settings.');
            }
            if (response.status === 403) {
                throw new Error('API key not authorized. Please check your Gemini API key in settings.');
            }
            throw new Error(error.error?.message || `API error: ${response.status}`);
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

        // Parse the JSON response (handle potential markdown fences)
        let jsonStr = text.trim();
        if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        }

        try {
            const parsed = JSON.parse(jsonStr);
            // Handle both old array format and new object format
            if (Array.isArray(parsed)) {
                return { hasTaxCodes: true, serviceCharge: null, items: parsed };
            }
            if (parsed && Array.isArray(parsed.items)) {
                return parsed;
            }
            console.warn('Gemini returned unexpected format:', parsed);
            return { hasTaxCodes: false, serviceCharge: null, items: [] };
        } catch (e) {
            console.error('Failed to parse Gemini response:', jsonStr);
            return { hasTaxCodes: false, serviceCharge: null, items: [] };
        }
    }

    // ---- PROCESS RECEIPTS ----
    els.processBtn.addEventListener('click', async () => {
        if (state.images.length === 0) return;

        // Check for API key
        const apiKey = getApiKey();
        if (!apiKey) {
            openSettings();
            return;
        }

        // UI: show loading
        els.processBtn.querySelector('.btn-text').classList.add('hidden');
        els.processBtn.querySelector('.btn-loading').classList.remove('hidden');
        els.processBtn.disabled = true;
        els.ocrProgress.classList.remove('hidden');

        const allItems = [];
        let detectedTaxCodes = false;
        let totalServiceCharge = 0;

        for (let i = 0; i < state.images.length; i++) {
            els.progressText.textContent = `Scanning image ${i + 1} of ${state.images.length}...`;
            els.progressFill.style.width = ((i + 0.5) / state.images.length) * 100 + '%';

            try {
                const result = await extractItemsWithGemini(state.images[i].file, apiKey);

                if (result.hasTaxCodes) detectedTaxCodes = true;
                if (result.serviceCharge) totalServiceCharge += parseFloat(result.serviceCharge) || 0;

                result.items.forEach((item) => {
                    allItems.push({
                        id: ++itemIdCounter,
                        name: String(item.name || '').substring(0, 60),
                        price: parseFloat(item.price) || 0,
                        taxCode: item.taxCode === 'A' ? 'A' : 'Z',
                        qty: 1,
                    });
                });
            } catch (err) {
                console.error('Gemini API error:', err);

                // If model not found, list available models
                if (err.message?.includes('not found')) {
                    els.progressText.textContent = 'Model not found. Check console for available models.';
                    listGeminiModels(apiKey);
                } else {
                    els.progressText.textContent = err.message || 'Error scanning receipt';
                }

                els.progressFill.style.width = '0%';
                els.processBtn.querySelector('.btn-text').classList.remove('hidden');
                els.processBtn.querySelector('.btn-loading').classList.add('hidden');
                els.processBtn.disabled = false;
                // Keep error visible until user taps progress area
                els.ocrProgress.onclick = () => {
                    els.ocrProgress.classList.add('hidden');
                    els.ocrProgress.onclick = null;
                };
                return;
            }
        }

        els.progressFill.style.width = '100%';
        els.progressText.textContent = 'Processing complete!';

        // Store items and detected settings
        state.items = allItems;
        state.hasTaxCodes = detectedTaxCodes;
        state.serviceCharge = totalServiceCharge > 0 ? totalServiceCharge : null;

        // Add service charge as an item if detected
        if (state.serviceCharge) {
            state.items.push({
                id: ++itemIdCounter,
                name: 'Service Charge',
                price: state.serviceCharge,
                taxCode: 'Z',
                qty: 1,
                isServiceCharge: true,
            });
        }

        // If no items found, add a blank one
        if (state.items.length === 0) {
            state.items.push({
                id: ++itemIdCounter,
                name: '',
                price: 0,
                taxCode: 'Z',
                qty: 1,
            });
        }

        // Reset UI
        setTimeout(() => {
            els.processBtn.querySelector('.btn-text').classList.remove('hidden');
            els.processBtn.querySelector('.btn-loading').classList.add('hidden');
            els.processBtn.disabled = false;
            els.ocrProgress.classList.add('hidden');
            els.progressFill.style.width = '0%';

            renderItems();
            updateTotals();
            showStep('step-items');
        }, 600);
    });

    // ---- RENDER ITEMS ----
    function renderItems() {
        els.itemsList.innerHTML = '';

        // Show/hide tax code UI based on detection
        if (state.hasTaxCodes) {
            els.taxRateBar.style.display = '';
            els.itemsStepDesc.textContent = 'Edit items, prices, and tax codes as needed. A = taxed, Z = non-taxed.';
        } else {
            els.taxRateBar.style.display = 'none';
            els.itemsStepDesc.textContent = 'Edit items and prices as needed.';
        }

        // Add/remove class for tax code visibility
        els.itemsList.classList.toggle('has-tax-codes', state.hasTaxCodes);

        state.items.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'item-row' + (state.hasTaxCodes ? '' : ' no-tax');
            row.dataset.id = item.id;

            const taxSelect = state.hasTaxCodes ? `
                <select class="item-tax">
                    <option value="A" ${item.taxCode === 'A' ? 'selected' : ''}>A</option>
                    <option value="Z" ${item.taxCode === 'Z' ? 'selected' : ''}>Z</option>
                </select>
            ` : '';

            row.innerHTML = `
                <input type="text" class="item-name" value="${escapeHtml(item.name)}" placeholder="Item name">
                <input type="number" class="item-price" value="${item.price.toFixed(2)}" step="0.01" min="0" placeholder="0.00">
                ${taxSelect}
                <button class="delete-item" title="Remove item">&times;</button>
            `;
            els.itemsList.appendChild(row);
        });

        // Event listeners
        els.itemsList.querySelectorAll('.item-name').forEach((input) => {
            input.addEventListener('input', (e) => {
                const id = parseInt(e.target.closest('.item-row').dataset.id);
                const item = state.items.find((i) => i.id === id);
                if (item) item.name = e.target.value;
            });
        });

        els.itemsList.querySelectorAll('.item-price').forEach((input) => {
            input.addEventListener('input', (e) => {
                const id = parseInt(e.target.closest('.item-row').dataset.id);
                const item = state.items.find((i) => i.id === id);
                if (item) {
                    item.price = parseFloat(e.target.value) || 0;
                    updateTotals();
                }
            });
        });

        if (state.hasTaxCodes) {
            els.itemsList.querySelectorAll('.item-tax').forEach((select) => {
                select.addEventListener('change', (e) => {
                    const id = parseInt(e.target.closest('.item-row').dataset.id);
                    const item = state.items.find((i) => i.id === id);
                    if (item) {
                        item.taxCode = e.target.value;
                        updateTotals();
                    }
                });
            });
        }

        els.itemsList.querySelectorAll('.delete-item').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const id = parseInt(e.target.closest('.item-row').dataset.id);
                state.items = state.items.filter((i) => i.id !== id);
                delete state.assignments[id];
                renderItems();
                updateTotals();
            });
        });
    }

    // ---- ADD ITEM MANUALLY ----
    els.addItemBtn.addEventListener('click', () => {
        state.items.push({
            id: ++itemIdCounter,
            name: '',
            price: 0,
            taxCode: 'Z',
            qty: 1,
        });
        renderItems();
        // Focus the new item's name input
        const lastInput = els.itemsList.querySelector('.item-row:last-child .item-name');
        if (lastInput) lastInput.focus();
    });

    // ---- TAX RATE ----
    els.taxRateInput.addEventListener('input', () => {
        state.taxRate = parseFloat(els.taxRateInput.value) || 0;
        updateTotals();
    });

    // ---- UPDATE TOTALS ----
    function updateTotals() {
        let subtotal = 0;
        let taxAmount = 0;

        state.items.forEach((item) => {
            subtotal += item.price;
            if (item.taxCode === 'A') {
                taxAmount += item.price * (state.taxRate / 100);
            }
        });

        const total = subtotal + taxAmount;

        els.subtotalDisplay.textContent = formatPrice(subtotal);
        els.taxDisplay.textContent = formatPrice(taxAmount);
        els.totalDisplay.textContent = formatPrice(total);
    }

    // ---- PEOPLE MANAGEMENT ----
    els.addPersonBtn.addEventListener('click', addPerson);
    els.personNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addPerson();
    });

    function addPerson() {
        const name = els.personNameInput.value.trim();
        if (!name) return;
        if (state.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) return;

        state.people.push({
            id: ++personIdCounter,
            name: name,
            color: PERSON_COLORS[(personIdCounter - 1) % PERSON_COLORS.length],
        });
        els.personNameInput.value = '';
        renderPeopleTags();
        renderAssignments();
    }

    function renderPeopleTags() {
        els.peopleTags.innerHTML = '';
        state.people.forEach((person) => {
            const tag = document.createElement('span');
            tag.className = 'person-tag';
            tag.innerHTML = `
                <span class="person-color" style="background:${person.color}"></span>
                ${escapeHtml(person.name)}
                <button class="remove-person" data-id="${person.id}">&times;</button>
            `;
            els.peopleTags.appendChild(tag);
        });

        els.peopleTags.querySelectorAll('.remove-person').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const id = parseInt(e.target.dataset.id);
                state.people = state.people.filter((p) => p.id !== id);
                // Remove from assignments
                Object.keys(state.assignments).forEach((itemId) => {
                    state.assignments[itemId] = state.assignments[itemId].filter((pid) => pid !== id);
                });
                renderPeopleTags();
                renderAssignments();
            });
        });
    }

    // ---- ASSIGNMENTS ----
    function renderAssignments() {
        els.assignList.innerHTML = '';

        if (state.people.length === 0) {
            els.assignList.innerHTML = '<p class="step-desc" style="text-align:center;">Add people above to start assigning items.</p>';
            return;
        }

        state.items.forEach((item) => {
            if (!item.name && item.price === 0) return; // Skip empty items

            if (!state.assignments[item.id]) {
                state.assignments[item.id] = [];
            }

            const row = document.createElement('div');
            row.className = 'assign-row';

            const taxLabel = item.taxCode === 'A' ? ' (taxed)' : '';

            row.innerHTML = `
                <div class="assign-row-header">
                    <span class="assign-item-name">${escapeHtml(item.name || 'Unnamed item')}</span>
                    <span>
                        <span class="assign-item-price">${formatPrice(item.price)}</span>
                        <span class="assign-item-tax">${item.taxCode}${taxLabel}</span>
                    </span>
                </div>
                <div class="assign-people-buttons" data-item-id="${item.id}">
                    ${state.people
                        .map(
                            (p) => `
                        <button class="assign-person-btn ${state.assignments[item.id].includes(p.id) ? 'selected' : ''}"
                                data-person-id="${p.id}"
                                style="${state.assignments[item.id].includes(p.id) ? `background:${p.color};border-color:${p.color};color:white;` : ''}">
                            ${escapeHtml(p.name)}
                        </button>
                    `
                        )
                        .join('')}
                </div>
            `;

            els.assignList.appendChild(row);
        });

        // Assignment button clicks
        els.assignList.querySelectorAll('.assign-person-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const itemId = parseInt(e.target.closest('.assign-people-buttons').dataset.itemId);
                const personId = parseInt(e.target.dataset.personId);

                if (!state.assignments[itemId]) state.assignments[itemId] = [];

                const idx = state.assignments[itemId].indexOf(personId);
                if (idx >= 0) {
                    state.assignments[itemId].splice(idx, 1);
                } else {
                    state.assignments[itemId].push(personId);
                }

                renderAssignments();
            });
        });
    }

    // ---- SUMMARY ----
    function renderSummary() {
        els.summaryContent.innerHTML = '';

        // Check for unassigned items
        const unassigned = state.items.filter(
            (item) =>
                (item.name || item.price > 0) &&
                (!state.assignments[item.id] || state.assignments[item.id].length === 0)
        );

        if (unassigned.length > 0) {
            const warning = document.createElement('div');
            warning.className = 'unassigned-warning';
            warning.textContent = `${unassigned.length} item(s) not assigned to anyone: ${unassigned.map((i) => i.name || 'Unnamed').join(', ')}`;
            els.summaryContent.appendChild(warning);
        }

        // Calculate each person's share
        state.people.forEach((person) => {
            const personItems = [];
            let personSubtotal = 0;
            let personTax = 0;

            state.items.forEach((item) => {
                if (!state.assignments[item.id] || !state.assignments[item.id].includes(person.id)) return;

                const splitCount = state.assignments[item.id].length;
                const share = item.price / splitCount;
                const shareTax = item.taxCode === 'A' ? share * (state.taxRate / 100) : 0;

                personItems.push({
                    name: item.name || 'Unnamed item',
                    fullPrice: item.price,
                    share: share,
                    shareTax: shareTax,
                    splitCount: splitCount,
                    taxCode: item.taxCode,
                });

                personSubtotal += share;
                personTax += shareTax;
            });

            const personTotal = personSubtotal + personTax;

            const card = document.createElement('div');
            card.className = 'summary-card';
            card.innerHTML = `
                <div class="summary-card-header">
                    <span class="summary-person-name" style="color:${person.color}">${escapeHtml(person.name)}</span>
                    <span class="summary-person-total">${formatPrice(personTotal)}</span>
                </div>
                <div class="summary-items">
                    ${personItems
                        .map(
                            (pi) => `
                        <div class="s-item">
                            <span>${escapeHtml(pi.name)}${pi.splitCount > 1 ? ` <span class="s-item-shared">(split ${pi.splitCount} ways)</span>` : ''}</span>
                            <span>${formatPrice(pi.share)}</span>
                        </div>
                    `
                        )
                        .join('')}
                    ${
                        personTax > 0
                            ? `<div class="s-item s-tax-line">
                            <span>Tax</span>
                            <span>${formatPrice(personTax)}</span>
                        </div>`
                            : ''
                    }
                </div>
                <div class="summary-actions">
                    <button class="btn-share whatsapp" data-person-id="${person.id}" data-channel="whatsapp">
                        WhatsApp
                    </button>
                    <button class="btn-share sms" data-person-id="${person.id}" data-channel="sms">
                        SMS
                    </button>
                    <button class="btn-share copy" data-person-id="${person.id}" data-channel="copy">
                        Copy
                    </button>
                </div>
            `;

            els.summaryContent.appendChild(card);
        });

        // Share button listeners
        els.summaryContent.querySelectorAll('.btn-share').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const personId = parseInt(e.target.dataset.personId);
                const channel = e.target.dataset.channel;
                sendMessage(personId, channel);
            });
        });
    }

    // ---- MESSAGE GENERATION ----
    function generateMessage(personId) {
        const person = state.people.find((p) => p.id === personId);
        if (!person) return '';

        let lines = [];
        lines.push(`Hi ${person.name}! Here's your share from our recent shop:\n`);

        let personSubtotal = 0;
        let personTax = 0;

        state.items.forEach((item) => {
            if (!state.assignments[item.id] || !state.assignments[item.id].includes(person.id)) return;

            const splitCount = state.assignments[item.id].length;
            const share = item.price / splitCount;
            const shareTax = item.taxCode === 'A' ? share * (state.taxRate / 100) : 0;

            let line = `- ${item.name || 'Item'}: ${formatPrice(share)}`;
            if (splitCount > 1) line += ` (split ${splitCount} ways)`;
            lines.push(line);

            personSubtotal += share;
            personTax += shareTax;
        });

        if (personTax > 0) {
            lines.push(`\nTax: ${formatPrice(personTax)}`);
        }

        const total = personSubtotal + personTax;
        lines.push(`\nTotal: ${formatPrice(total)}`);
        lines.push('\nCheers!');

        return lines.join('\n');
    }

    function sendMessage(personId, channel) {
        const message = generateMessage(personId);
        const encoded = encodeURIComponent(message);

        switch (channel) {
            case 'whatsapp':
                window.open(`https://wa.me/?text=${encoded}`, '_blank');
                break;
            case 'sms':
                window.open(`sms:?body=${encoded}`, '_blank');
                break;
            case 'copy': {
                const btn = els.summaryContent.querySelector(
                    `.btn-share.copy[data-person-id="${personId}"]`
                );
                const showFeedback = (success) => {
                    if (btn) {
                        const original = btn.textContent;
                        btn.textContent = success ? 'Copied!' : 'Failed';
                        setTimeout(() => (btn.textContent = original), 2000);
                    }
                };

                // Try modern clipboard API first, fallback to textarea method
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(message)
                        .then(() => showFeedback(true))
                        .catch(() => fallbackCopy(message, showFeedback));
                } else {
                    fallbackCopy(message, showFeedback);
                }
                break;
            }
        }
    }

    // ---- NAVIGATION HANDLERS ----
    els.backToUpload.addEventListener('click', () => showStep('step-upload'));

    els.toAssign.addEventListener('click', () => {
        // Filter out completely empty items
        state.items = state.items.filter((i) => i.name.trim() || i.price > 0);
        if (state.items.length === 0) {
            showToast('Please add at least one item before continuing.');
            return;
        }
        renderAssignments();
        showStep('step-assign');
    });

    els.backToItems.addEventListener('click', () => {
        renderItems();
        updateTotals();
        showStep('step-items');
    });

    els.toSummary.addEventListener('click', () => {
        if (state.people.length === 0) {
            showToast('Please add at least one person before continuing.');
            return;
        }
        renderSummary();
        showStep('step-summary');
    });

    els.backToAssign.addEventListener('click', () => {
        renderAssignments();
        showStep('step-assign');
    });

    els.startOver.addEventListener('click', () => {
        // Reset state
        state.images.forEach((img) => URL.revokeObjectURL(img.url));
        state.images = [];
        state.items = [];
        state.people = [];
        state.assignments = {};
        state.hasTaxCodes = false;
        state.serviceCharge = null;
        itemIdCounter = 0;
        personIdCounter = 0;

        // Reset UI
        els.imagePreviewContainer.innerHTML = '';
        els.imagePreviewContainer.classList.add('hidden');
        els.processBtn.classList.add('hidden');
        els.receiptInput.value = '';

        showStep('step-upload');
    });

    // ---- HELPERS ----
    const toastEl = $('#toast');
    let toastTimeout;

    function showToast(message, duration = 3000) {
        clearTimeout(toastTimeout);
        toastEl.textContent = message;
        toastEl.classList.remove('hidden');

        // Trigger reflow for animation
        toastEl.offsetHeight;
        toastEl.classList.add('visible');

        toastTimeout = setTimeout(() => {
            toastEl.classList.remove('visible');
        }, duration);
    }

    function fallbackCopy(text, callback) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            callback(true);
        } catch (err) {
            console.error('Fallback copy failed:', err);
            callback(false);
        }
        document.body.removeChild(textarea);
    }

    function formatPrice(amount) {
        return '£' + amount.toFixed(2);
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
})();
