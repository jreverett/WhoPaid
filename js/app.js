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
    };

    let itemIdCounter = 0;
    let personIdCounter = 0;

    const PERSON_COLORS = [
        '#d4380d', '#1890ff', '#389e0d', '#722ed1',
        '#eb2f96', '#fa8c16', '#13c2c2', '#595959',
    ];

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
    };

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

    // ---- OCR ----
    els.processBtn.addEventListener('click', async () => {
        if (state.images.length === 0) return;

        // UI: show loading
        els.processBtn.querySelector('.btn-text').classList.add('hidden');
        els.processBtn.querySelector('.btn-loading').classList.remove('hidden');
        els.processBtn.disabled = true;
        els.ocrProgress.classList.remove('hidden');

        const allText = [];

        for (let i = 0; i < state.images.length; i++) {
            els.progressText.textContent = `Scanning image ${i + 1} of ${state.images.length}...`;

            try {
                const worker = await Tesseract.createWorker('eng', 1, {
                    logger: (m) => {
                        if (m.status === 'recognizing text') {
                            const overall = ((i + m.progress) / state.images.length) * 100;
                            els.progressFill.style.width = overall + '%';
                        }
                    },
                });

                const { data } = await worker.recognize(state.images[i].file);
                allText.push(data.text);
                await worker.terminate();
            } catch (err) {
                console.error('OCR error:', err);
                allText.push('');
            }
        }

        els.progressFill.style.width = '100%';
        els.progressText.textContent = 'Processing complete!';

        // Parse all text
        const combinedText = allText.join('\n');
        state.items = parseReceiptText(combinedText);

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

    // ---- PARSE RECEIPT TEXT ----
    function parseReceiptText(text) {
        const items = [];
        const lines = text.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Try various Costco-style receipt patterns
            // Pattern: ITEM NAME    PRICE  TAX_CODE
            // Common Costco formats:
            //   ITEM NAME           1.23 A
            //   ITEM NAME           1.23 Z
            //   ITEM NAME      1.23A
            //   ITEM NAME      1.23 Z

            let match;

            // Pattern 1: name ... price ... tax code (A or Z) at end
            match = trimmed.match(/^(.+?)\s+([\d]+[.,]\d{2})\s*([AaZz])\s*$/);
            if (!match) {
                // Pattern 2: price with tax code directly attached
                match = trimmed.match(/^(.+?)\s+([\d]+[.,]\d{2})([AaZz])\s*$/);
            }
            if (!match) {
                // Pattern 3: name ... price (no tax code)
                match = trimmed.match(/^(.+?)\s{2,}([\d]+[.,]\d{2})\s*$/);
            }

            if (match) {
                const name = match[1].trim();
                const priceStr = match[2].replace(',', '.');
                const price = parseFloat(priceStr);
                const taxCode = match[3] ? match[3].toUpperCase() : 'Z';

                // Skip lines that look like totals, subtotals, tax lines, etc.
                const skipWords = ['total', 'subtotal', 'sub total', 'tax', 'change', 'cash', 'card', 'visa', 'mastercard', 'debit', 'credit', 'balance', 'payment', 'amount'];
                const lowerName = name.toLowerCase();
                if (skipWords.some((w) => lowerName.includes(w))) continue;
                if (price <= 0 || isNaN(price)) continue;

                items.push({
                    id: ++itemIdCounter,
                    name: name.substring(0, 60),
                    price: price,
                    taxCode: taxCode,
                    qty: 1,
                });
            }
        }

        // If no items found, add a blank one so user can manually enter
        if (items.length === 0) {
            items.push({
                id: ++itemIdCounter,
                name: '',
                price: 0,
                taxCode: 'Z',
                qty: 1,
            });
        }

        return items;
    }

    // ---- RENDER ITEMS ----
    function renderItems() {
        els.itemsList.innerHTML = '';
        state.items.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'item-row';
            row.dataset.id = item.id;
            row.innerHTML = `
                <input type="text" class="item-name" value="${escapeHtml(item.name)}" placeholder="Item name">
                <input type="number" class="item-price" value="${item.price.toFixed(2)}" step="0.01" min="0" placeholder="0.00">
                <select class="item-tax">
                    <option value="A" ${item.taxCode === 'A' ? 'selected' : ''}>A</option>
                    <option value="Z" ${item.taxCode === 'Z' ? 'selected' : ''}>Z</option>
                </select>
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
                    <button class="btn-share email" data-person-id="${person.id}" data-channel="email">
                        Email
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
            case 'email': {
                const person = state.people.find((p) => p.id === personId);
                const subject = encodeURIComponent('Your share from our shop');
                window.open(`mailto:?subject=${subject}&body=${encoded}`, '_blank');
                break;
            }
            case 'copy':
                navigator.clipboard.writeText(message).then(() => {
                    const btn = els.summaryContent.querySelector(
                        `.btn-share.copy[data-person-id="${personId}"]`
                    );
                    if (btn) {
                        const original = btn.textContent;
                        btn.textContent = 'Copied!';
                        setTimeout(() => (btn.textContent = original), 2000);
                    }
                });
                break;
        }
    }

    // ---- NAVIGATION HANDLERS ----
    els.backToUpload.addEventListener('click', () => showStep('step-upload'));

    els.toAssign.addEventListener('click', () => {
        // Filter out completely empty items
        state.items = state.items.filter((i) => i.name.trim() || i.price > 0);
        if (state.items.length === 0) {
            alert('Please add at least one item before continuing.');
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
            alert('Please add at least one person before continuing.');
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
    function formatPrice(amount) {
        return '£' + amount.toFixed(2);
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
})();
