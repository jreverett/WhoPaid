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
        storeName: null,   // extracted from receipt header
        receiptId: null,   // GUID after saving
        hasImages: false,  // whether receipt has stored images
    };

    let itemIdCounter = 0;
    let personIdCounter = 0;

    const PERSON_COLORS = [
        '#d4380d', '#1890ff', '#389e0d', '#722ed1',
        '#eb2f96', '#fa8c16', '#13c2c2', '#595959',
    ];

    const STORAGE_KEY_RECENT = 'recentReceipts';
    const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

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
        // Recent receipts
        recentReceipts: $('#recentReceipts'),
        recentList: $('#recentList'),
        clearRecent: $('#clearRecent'),
        // View mode
        viewContent: $('#viewContent'),
    };

    // ---- RECEIPT PERSISTENCE ----
    function getRecentReceipts() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY_RECENT);
            if (!stored) return [];
            const receipts = JSON.parse(stored);
            // Filter out expired receipts
            const now = Date.now();
            return receipts.filter(r => now - r.savedAt < FOURTEEN_DAYS_MS);
        } catch (e) {
            return [];
        }
    }

    function saveRecentReceipts(receipts) {
        localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(receipts.slice(0, 10)));
    }

    function addToRecentReceipts(id, label) {
        const receipts = getRecentReceipts();
        // Remove any existing entry with this ID
        const filtered = receipts.filter(r => r.id !== id);
        // Add new entry at the beginning
        filtered.unshift({ id, savedAt: Date.now(), label });
        saveRecentReceipts(filtered);
        renderRecentReceipts();
    }

    function renderRecentReceipts() {
        const receipts = getRecentReceipts();
        if (receipts.length === 0) {
            els.recentReceipts.classList.add('hidden');
            return;
        }

        els.recentReceipts.classList.remove('hidden');
        els.recentList.innerHTML = receipts.map(r => {
            const date = new Date(r.savedAt).toLocaleDateString();
            return `<li class="recent-item">
                <a href="/r/${r.id}">${escapeHtml(r.label)}</a>
                <span class="recent-date">${date}</span>
            </li>`;
        }).join('');
    }

    els.clearRecent.addEventListener('click', () => {
        localStorage.removeItem(STORAGE_KEY_RECENT);
        renderRecentReceipts();
    });

    async function saveReceipt() {
        // Build a label for the receipt
        const peopleCount = state.people.length;
        const firstItem = state.items.find(i => i.name) || { name: 'Receipt' };
        const label = `${firstItem.name.substring(0, 20)} - ${peopleCount} ${peopleCount === 1 ? 'person' : 'people'}`;

        // Compress images for storage
        let compressedImages = [];
        if (state.images.length > 0) {
            try {
                compressedImages = await Promise.all(state.images.map(img => compressImage(img.file)));
            } catch (e) {
                console.error('Failed to compress images for storage:', e);
            }
        }

        // Prepare state data for saving
        const saveData = {
            items: state.items,
            people: state.people,
            assignments: state.assignments,
            taxRate: state.taxRate,
            hasTaxCodes: state.hasTaxCodes,
            serviceCharge: state.serviceCharge,
            storeName: state.storeName,
            images: compressedImages,
        };

        try {
            const response = await fetch('/api/receipts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(saveData),
            });

            if (!response.ok) {
                throw new Error('Failed to save receipt');
            }

            const result = await response.json();
            state.receiptId = result.id;

            // Update URL without reload
            window.history.pushState({}, '', `/r/${result.id}`);

            // Add to recent receipts
            addToRecentReceipts(result.id, label);

            return result.id;
        } catch (error) {
            console.error('Failed to save receipt:', error);
            // Non-blocking - receipt sharing still works without persistence
            return null;
        }
    }

    async function loadSharedReceipt(id) {
        try {
            const response = await fetch(`/api/receipts/${id}`);
            if (!response.ok) {
                if (response.status === 404) {
                    showToast('Receipt not found or expired');
                }
                return false;
            }

            const result = await response.json();
            const data = result.data;

            // Populate state from saved data
            state.items = data.items || [];
            state.people = data.people || [];
            state.assignments = data.assignments || {};
            state.taxRate = data.taxRate ?? 20;
            state.hasTaxCodes = data.hasTaxCodes || false;
            state.serviceCharge = data.serviceCharge || null;
            state.storeName = data.storeName || null;
            state.receiptId = id;
            state.hasImages = data.hasImages || false;

            // Update counters to avoid ID conflicts
            itemIdCounter = Math.max(0, ...state.items.map(i => i.id));
            personIdCounter = Math.max(0, ...state.people.map(p => p.id));

            return true;
        } catch (error) {
            console.error('Failed to load receipt:', error);
            showToast('Failed to load receipt');
            return false;
        }
    }

    async function loadReceiptImages() {
        if (!state.receiptId || !state.hasImages) return null;

        try {
            const response = await fetch(`/api/receipts/${state.receiptId}/images`);
            if (!response.ok) return null;

            const data = await response.json();
            return data.images || [];
        } catch (error) {
            console.error('Failed to load receipt images:', error);
            return null;
        }
    }

    function renderViewOnlySummary() {
        els.viewContent.innerHTML = '';

        // Add "View Receipt" button if images are available
        if (state.hasImages) {
            const imageSection = document.createElement('div');
            imageSection.className = 'receipt-images-section';
            imageSection.innerHTML = `
                <button class="btn btn-secondary view-receipt-btn">View Original Receipt</button>
                <div class="receipt-images-container hidden"></div>
            `;
            els.viewContent.appendChild(imageSection);

            const viewBtn = imageSection.querySelector('.view-receipt-btn');
            const imagesContainer = imageSection.querySelector('.receipt-images-container');

            viewBtn.addEventListener('click', async () => {
                if (imagesContainer.classList.contains('loaded')) {
                    // Toggle visibility
                    imagesContainer.classList.toggle('hidden');
                    viewBtn.textContent = imagesContainer.classList.contains('hidden')
                        ? 'View Original Receipt'
                        : 'Hide Receipt';
                    return;
                }

                // Load images
                viewBtn.textContent = 'Loading...';
                viewBtn.disabled = true;

                const images = await loadReceiptImages();
                if (images && images.length > 0) {
                    imagesContainer.innerHTML = images.map((img, i) => `
                        <img src="data:${img.mimeType};base64,${img.data}"
                             alt="Receipt image ${i + 1}"
                             class="receipt-image">
                    `).join('');
                    imagesContainer.classList.add('loaded');
                    imagesContainer.classList.remove('hidden');
                    viewBtn.textContent = 'Hide Receipt';
                } else {
                    viewBtn.textContent = 'Images unavailable';
                }
                viewBtn.disabled = false;
            });
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
                    share: share,
                    splitCount: splitCount,
                });

                personSubtotal += share;
                personTax += shareTax;
            });

            const personTotal = personSubtotal + personTax;

            const card = document.createElement('div');
            card.className = 'summary-card view-only';
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
            `;

            els.viewContent.appendChild(card);
        });
    }

    // Check for shared receipt URL on page load
    async function checkForSharedReceipt() {
        const path = window.location.pathname;
        const match = path.match(/^\/r\/([a-f0-9-]+)$/i);

        if (match) {
            const receiptId = match[1];
            const loaded = await loadSharedReceipt(receiptId);

            if (loaded) {
                renderViewOnlySummary();
                showStep('step-view');
            } else {
                // Receipt not found, show upload page
                showStep('step-upload');
            }
        } else {
            // Normal flow - show recent receipts
            renderRecentReceipts();
        }
    }

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

    // ---- RECEIPT SCANNING API ----
    const MAX_IMAGE_DIMENSION = 2400; // Max width or height (increased for OCR accuracy)
    const IMAGE_QUALITY = 0.92; // JPEG quality (increased for text clarity)
    const MAX_FILE_SIZE_KB = 1200; // Target max size per image

    // Detect receipt boundaries and return crop coordinates
    function detectReceiptBounds(imageData, width, height) {
        const data = imageData.data;
        const BRIGHTNESS_THRESHOLD = 180; // Pixels brighter than this are likely receipt paper
        const SAMPLE_STEP = 4; // Sample every 4th pixel for performance

        let minX = width, maxX = 0, minY = height, maxY = 0;
        let receiptPixelCount = 0;

        // Scan for bright (receipt paper) pixels
        for (let y = 0; y < height; y += SAMPLE_STEP) {
            for (let x = 0; x < width; x += SAMPLE_STEP) {
                const idx = (y * width + x) * 4;
                const r = data[idx];
                const g = data[idx + 1];
                const b = data[idx + 2];
                const brightness = (r + g + b) / 3;

                if (brightness > BRIGHTNESS_THRESHOLD) {
                    receiptPixelCount++;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }

        // If we found enough bright pixels, use detected bounds
        const totalSampled = (width / SAMPLE_STEP) * (height / SAMPLE_STEP);
        const brightRatio = receiptPixelCount / totalSampled;

        // Only crop if there's a clear receipt area (10-90% of image is bright)
        if (brightRatio > 0.1 && brightRatio < 0.9 && maxX > minX && maxY > minY) {
            // Add padding (5% of dimensions)
            const padX = Math.round(width * 0.03);
            const padY = Math.round(height * 0.03);

            return {
                x: Math.max(0, minX - padX),
                y: Math.max(0, minY - padY),
                width: Math.min(width, maxX - minX + 2 * padX),
                height: Math.min(height, maxY - minY + 2 * padY),
                cropped: true
            };
        }

        // No clear receipt detected, use full image
        return { x: 0, y: 0, width, height, cropped: false };
    }

    async function compressImage(file) {
        return new Promise((resolve, reject) => {
            const img = new Image();

            img.onload = () => {
                // First, draw full image to detect receipt bounds
                const detectCanvas = document.createElement('canvas');
                const detectCtx = detectCanvas.getContext('2d');

                // Use smaller size for detection (faster)
                const detectScale = Math.min(1, 800 / Math.max(img.width, img.height));
                detectCanvas.width = Math.round(img.width * detectScale);
                detectCanvas.height = Math.round(img.height * detectScale);
                detectCtx.drawImage(img, 0, 0, detectCanvas.width, detectCanvas.height);

                const imageData = detectCtx.getImageData(0, 0, detectCanvas.width, detectCanvas.height);
                const bounds = detectReceiptBounds(imageData, detectCanvas.width, detectCanvas.height);

                // Scale bounds back to original image size
                const scale = 1 / detectScale;
                const cropX = Math.round(bounds.x * scale);
                const cropY = Math.round(bounds.y * scale);
                const cropW = Math.round(bounds.width * scale);
                const cropH = Math.round(bounds.height * scale);

                // Calculate output dimensions
                let outWidth = cropW;
                let outHeight = cropH;

                if (outWidth > MAX_IMAGE_DIMENSION || outHeight > MAX_IMAGE_DIMENSION) {
                    if (outWidth > outHeight) {
                        outHeight = Math.round((outHeight * MAX_IMAGE_DIMENSION) / outWidth);
                        outWidth = MAX_IMAGE_DIMENSION;
                    } else {
                        outWidth = Math.round((outWidth * MAX_IMAGE_DIMENSION) / outHeight);
                        outHeight = MAX_IMAGE_DIMENSION;
                    }
                }

                // Draw cropped and scaled image
                const outputCanvas = document.createElement('canvas');
                const outputCtx = outputCanvas.getContext('2d');
                outputCanvas.width = outWidth;
                outputCanvas.height = outHeight;

                outputCtx.drawImage(
                    img,
                    cropX, cropY, cropW, cropH,  // Source rectangle
                    0, 0, outWidth, outHeight     // Destination rectangle
                );

                // Convert to JPEG with compression
                const dataUrl = outputCanvas.toDataURL('image/jpeg', IMAGE_QUALITY);
                const base64 = dataUrl.split(',')[1];
                const outputSizeKB = Math.round(base64.length * 0.75 / 1024);

                console.log(`Image processed: ${Math.round(file.size / 1024)}KB -> ${outputSizeKB}KB` +
                    (bounds.cropped ? ` (cropped to receipt)` : ` (no crop needed)`));

                resolve({
                    mimeType: 'image/jpeg',
                    data: base64,
                });
            };

            img.onerror = () => reject(new Error('Failed to load image'));

            // Load image from file
            const reader = new FileReader();
            reader.onload = (e) => { img.src = e.target.result; };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    async function extractItemsFromReceipt(imageFiles) {
        // Compress and convert all images
        const images = await Promise.all(imageFiles.map(compressImage));

        // Check total payload size
        const totalSizeKB = images.reduce((sum, img) => sum + img.data.length * 0.75 / 1024, 0);
        if (totalSizeKB > 5000) {
            throw new Error('Images are too large. Please use fewer or smaller images.');
        }

        const response = await fetch('/api/gemini', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ images }),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            if (response.status === 429) {
                throw new Error(error.error || 'Daily limit reached. Please try again tomorrow.');
            }
            throw new Error(error.error || 'Failed to process receipt');
        }

        return response.json();
    }

    // ---- PROGRESS ANIMATION ----
    let progressInterval = null;
    let currentProgress = 0;

    function setProgress(percent, text) {
        currentProgress = percent;
        els.progressFill.style.width = `${percent}%`;
        if (text) els.progressText.textContent = text;
    }

    function startProgressAnimation(phases) {
        // phases: [{target: 20, text: 'Compressing...'}, {target: 85, text: 'Analyzing...'}]
        let phaseIndex = 0;
        currentProgress = 0;
        setProgress(0, phases[0].text);

        if (progressInterval) clearInterval(progressInterval);

        progressInterval = setInterval(() => {
            const phase = phases[phaseIndex];
            if (!phase) {
                clearInterval(progressInterval);
                return;
            }

            // Slow down as we approach the target (easing)
            const remaining = phase.target - currentProgress;
            const increment = Math.max(0.3, remaining * 0.08);
            currentProgress = Math.min(phase.target, currentProgress + increment);

            els.progressFill.style.width = `${currentProgress}%`;

            // Move to next phase when close enough
            if (currentProgress >= phase.target - 0.5) {
                phaseIndex++;
                if (phases[phaseIndex]) {
                    els.progressText.textContent = phases[phaseIndex].text;
                }
            }
        }, 100);
    }

    function stopProgressAnimation() {
        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }
    }

    // ---- PROCESS RECEIPTS ----
    els.processBtn.addEventListener('click', async () => {
        if (state.images.length === 0) return;

        // UI: show loading
        els.processBtn.querySelector('.btn-text').classList.add('hidden');
        els.processBtn.querySelector('.btn-loading').classList.remove('hidden');
        els.processBtn.disabled = true;
        els.ocrProgress.classList.remove('hidden');

        const imageCount = state.images.length;

        // Start animated progress with phases
        startProgressAnimation([
            { target: 15, text: imageCount === 1 ? 'Preparing image...' : `Preparing ${imageCount} images...` },
            { target: 30, text: 'Uploading...' },
            { target: 85, text: 'Analyzing receipt...' }
        ]);

        let result;
        try {
            // Send all images in a single API call for deduplication
            const imageFiles = state.images.map(img => img.file);
            result = await extractItemsFromReceipt(imageFiles);
        } catch (err) {
            console.error('Receipt scanning error:', err);
            stopProgressAnimation();
            els.progressText.textContent = err.message || 'Error scanning receipt';

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

        stopProgressAnimation();
        setProgress(100, 'Processing complete!');

        const allItems = [];
        result.items.forEach((item) => {
            allItems.push({
                id: ++itemIdCounter,
                name: String(item.name || '').substring(0, 60),
                price: parseFloat(item.price) || 0,
                taxCode: item.taxCode === 'A' ? 'A' : 'Z',
                qty: 1,
            });
        });

        const detectedTaxCodes = result.hasTaxCodes;
        const totalServiceCharge = parseFloat(result.serviceCharge) || 0;
        const extractedStoreName = result.storeName || null;

        // Store items and detected settings
        state.hasTaxCodes = detectedTaxCodes;
        state.serviceCharge = totalServiceCharge > 0 ? totalServiceCharge : null;
        state.storeName = extractedStoreName;

        // Filter out any service charge items Gemini may have included to avoid duplication
        const serviceChargePattern = /service\s*charge|gratuity|tip/i;
        state.items = allItems.filter(item => !serviceChargePattern.test(item.name));

        // Add service charge as a single synthetic item if detected
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

        // Add link to full breakdown if we have a receipt ID
        if (state.receiptId) {
            const baseUrl = window.location.origin;
            lines.push(`\nView full breakdown: ${baseUrl}/r/${state.receiptId}`);
        }

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

    els.toSummary.addEventListener('click', async () => {
        if (state.people.length === 0) {
            showToast('Please add at least one person before continuing.');
            return;
        }
        renderSummary();
        showStep('step-summary');

        // Save receipt to database and re-render to include URL in share messages
        await saveReceipt();
        renderSummary();
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
        state.storeName = null;
        state.receiptId = null;
        itemIdCounter = 0;
        personIdCounter = 0;

        // Reset URL to root
        window.history.pushState({}, '', '/');

        // Reset UI
        els.imagePreviewContainer.innerHTML = '';
        els.imagePreviewContainer.classList.add('hidden');
        els.processBtn.classList.add('hidden');
        els.receiptInput.value = '';

        renderRecentReceipts();
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

    // Initialize - check for shared receipt URL
    checkForSharedReceipt();
})();
