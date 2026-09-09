document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('submissionForm');
    const fieldsContainer = document.getElementById('sample-fields');
    const addBtn = document.getElementById('add-sample-btn');
    const summaryEl = document.getElementById('samples-summary');
    const hiddenFieldsContainer = document.getElementById('hidden-fields-container');

    const networkServices = {
        'ABC': ['ABCPLUS'],
        'CBS': ['ExtraVision'],
        'KET': ['KETAGTEXT'],
        'NBC': ['NBCTeletext'],
        'TBS': ['Electra', 'Keyfax']
    };

    const AFFILIATE_NETWORKS = ['ABC', 'CBS', 'NBC'];

    const FIELD_NAMES = [
        'network',
        'affiliate',
        'otherNetwork',
        'service',
        'otherService',
        'date',
        'programTitle',
        'tapeType',
        'tapeSpeed',
        'submissionLink'
    ];

    // If there are multiple samples, they need to be kept in memory.
    let samples = [];
    // This will remain null unless a sample is being edited
    let editingIndex = null;

    // Update available tape speed options depending on the selected tape format
    function updateTapeSpeedOptions(scope) {
        const tapeTypeSelect = scope.querySelector('.tape-select');
        const tapeSpeedSelect = scope.querySelector('.speed-select');
        const betamaxGroup = tapeSpeedSelect.querySelector('optgroup[label=Betamax]');
        const vhsGroup = tapeSpeedSelect.querySelector('optgroup[label=VHS]');
        const tapeType = tapeTypeSelect.value;
        const currentValue = tapeSpeedSelect.value;

        let activeGroup = null;

        if (tapeType === 'VHS') {
            betamaxGroup.hidden = true;
            betamaxGroup.disabled = true;
            vhsGroup.hidden = false;
            vhsGroup.disabled = false;
            activeGroup = vhsGroup;

        } else if (tapeType === 'Betamax') {
            vhsGroup.hidden = true;
            vhsGroup.disabled = true;
            betamaxGroup.hidden = false;
            betamaxGroup.disabled = false;
            activeGroup = betamaxGroup;

            // No tape format chosen yet; disable the entire tape speed dropdown until the user picks a format first.
        } else {
            betamaxGroup.hidden = false;
            betamaxGroup.disabled = true;
            vhsGroup.hidden = false;
            vhsGroup.disabled = true;
        }

        // Prevent invalid selection
        const stillValid = activeGroup && Array.from(activeGroup.querySelectorAll('option')).some(o => o.value === currentValue);

        if (!stillValid) {
            tapeSpeedSelect.value = '';
        }
    }

    // Show the necessary form fields if a user selects "Other" in the Network section
    function updateOtherNetworkField(scope) {
        const networkSelect = scope.querySelector('.network-select');
        const wrap = scope.querySelector('.other-network-wrap');
        const input = scope.querySelector('.other-network-input');
        const isOther = networkSelect.value === 'Other';

        wrap.classList.toggle('d-none', !isOther);
        input.required = isOther;
        if (!isOther) input.value = '';
    }

    // Change the selected service based on the selected network
    function updateTextService(scope) {
        const networkSelect = scope.querySelector('.network-select');
        const serviceSelectOptions = scope.querySelector('.service-select-options-input');
        const serviceSelect = scope.querySelector('.service-select');
        const hint = scope.querySelector('.service-hint');
        const otherServiceWrap = scope.querySelector('.other-service-wrap');
        const otherServiceInput = scope.querySelector('.other-service-input');
        const allOptions = Array.from(serviceSelect.options).filter(o => o.value !== '');
        const currentValue = serviceSelect.value;

        // Remember the original service options in case someone wants to change the value from "Other" to another network
        if (!serviceSelect.dataset.optionsCached) {
            serviceSelect._allOptionsHTML = serviceSelect.innerHTML;
            serviceSelect.dataset.optionsCached = 'true';
        }

        /*
        If the user chooses "Other", disable the service options, remove the "required" attribute,
        hide the TBS hint, and show a new form input field for the name of the network
        */
        if (networkSelect.value === 'Other') {
            serviceSelectOptions.hidden = true;
            serviceSelect.disabled = true;
            serviceSelect.required = false;
            serviceSelect.value = '';
            hint.hidden = true;

            otherServiceWrap.classList.remove('d-none');
            otherServiceInput.required = true;
            return;
        }

        // If "Other" is not chosen, don't hide the service options, but keep the new form input hidden
        serviceSelectOptions.hidden = false;
        otherServiceWrap.classList.add('d-none');
        otherServiceInput.required = false;
        otherServiceInput.value = '';

        const validServices = networkServices[networkSelect.value] || [];

        serviceSelect.innerHTML = serviceSelect._allOptionsHTML;

        // Remove invalid services. If not blank and not a valid service for a network, it'll be removed
        Array.from(serviceSelect.options).forEach(opt => {
            if (opt.value !== '' && !validServices.includes(opt.value)) {
                opt.remove();
            }
        });

        serviceSelect.required = true;

        // ABC, CBS, KET, or NBC: exactly one valid service. Auto-select it and lock the field
        if (validServices.length === 1) {
            serviceSelect.value = validServices[0];
            serviceSelect.disabled = true;
            hint.hidden = true;

            // For TBS: let someone choose between Electra and Keyfax. There is no default option since TBS used both services.
        } else if (validServices.length > 1) {
            serviceSelect.value = validServices.includes(currentValue) ? currentValue : '';
            serviceSelect.disabled = false;
            hint.hidden = false;

            // No network chosen yet.
        } else {
            serviceSelect.value = '';
            serviceSelect.disabled = true;
            hint.hidden = true;
        }
    }

    // If ABC, CBS, or NBC are chosen, enable the form affiliate input form field
    function updateAffiliateField(scope) {
        const networkSelect = scope.querySelector('.network-select');
        const affiliateInput = scope.querySelector('.affiliate-input');
        const isEnabled = AFFILIATE_NETWORKS.includes(networkSelect.value);

        affiliateInput.disabled = !isEnabled;

        if (!isEnabled) {
            affiliateInput.value = '';
        }
    }

    // Function calls
    function initFields(scope) {
        updateTapeSpeedOptions(scope);
        updateTextService(scope);
        updateAffiliateField(scope);
        updateOtherNetworkField(scope);
    }

    // Take everything in the form and convert them to JavaScript objects
    function readCurrentFields() {
        const data = {};
        FIELD_NAMES.forEach(name => {
            const el = fieldsContainer.querySelector(`[name="${name}"], [name="${name}[]"]`);
            data[name] = el ? el.value : '';
        });
        return data;
    }

    // Take the JavaScript objects and write them back into the form
    function writeFields(data) {
        FIELD_NAMES.forEach(name => {
            const el = fieldsContainer.querySelector(`[name="${name}"], [name="${name}[]"]`);
            if (el) el.value = data[name] || ''
        });
        initFields(fieldsContainer);
    }

    // Clear the current form
    function clearFields() {
        fieldsContainer.querySelectorAll('input, textarea').forEach(el => { el.value = '' });
        fieldsContainer.querySelectorAll('select').forEach(el => { el.selectedIndex = 0 });
        initFields(fieldsContainer);
    }

    // Display every sample a user has created inside a compact container and give them the option to edit or remove a sample
    function renderSummary() {
        summaryEl.innerHTML = '';
        if (samples.length === 0) return;

        const list = document.createElement('div');
        list.className = 'list-group';

        samples.forEach((s, i) => {
            const row = document.createElement('div');
            row.className = "list-group-item d-flex justify-content-between align-items-center";

            const networkLabel = s.network === 'Other' ? s.otherNetwork : s.network;
            const serviceLabel = s.service === 'Other' || !s.service ? s.otherService : s.service;

            // Sample row label (i.e. CBS - ExtraVision - "Program Title")
            row.innerHTML = `
            <span>Sample ${i + 1}: ${networkLabel} - ${serviceLabel} - "${s.programTitle}"</span>
            <span>
                <button type="button" class="btn btn-sm btn-outline-secondary edit-sample" data-index="${i}">Edit</button>
                <button type="button" class="btn btn-sm btn-outline-danger remove-sample" data-index="${i}">Remove</button>
            </span>
            `;
            list.appendChild(row)
        });
        summaryEl.appendChild(list);
    }

    // Add current submission form to list if submitting multiple samples
    addBtn.addEventListener('click', () => {
        const invalid = fieldsContainer.querySelector(':invalid');

        if (invalid) {
            invalid.reportValidity();
            invalid.focus();
            return;
        }

        const data = readCurrentFields();

        if (editingIndex !== null) {
            samples[editingIndex] = data;
            editingIndex = null;
            addBtn.textContent = 'Add to List';
        } else {
            samples.push(data);
        }

        clearFields();
        renderSummary();
    });

    // Log the submit button
    const submitBtn = form.querySelector('button[type="submit"]');

    // Strip the "required" attribute from those specific elements after a submission is added to the list.
    submitBtn.forEach('click', () => {
        if (samples.length === 0) return;

        fieldsContainer.querySelectorAll('[required]').forEach(el => {
            el.required = false;
        });
    });

    // Trigger all delete or edit buttons for each sample (if multiple)
    summaryEl.addEventListener('click', (e) => {
        const i = e.target.dataset.index;
        if (i === undefined) return;

        if (e.target.classList.contains('remove-sample')) {
            samples.splice(i, 1);

            if (editingIndex !== null) {
                editingIndex = null;
                addBtn.textContent = 'Add to List';
                clearFields();
            }
            renderSummary();
        }

        if (e.target.classList.contains('edit-sample')) {
            writeFields(samples[i]);
            editingIndex = Number(i);
            addBtn.textContent = `Update sample ${Number(i) + 1}`;
        }
    });

    // Check which form fields have changed
    fieldsContainer.addEventListener('change', (e) => {
        if (e.target.classList.contains('network-select')) {
            updateTextService(fieldsContainer);
            updateAffiliateField(fieldsContainer);
            updateOtherNetworkField(fieldsContainer);
        }

        if (e.target.classList.contains('tape-select')) {
            updateTapeSpeedOptions(fieldsContainer);
        }
    });

    // Stop form submission if there are no samples
    form.addEventListener('submit', (e) => {
        // Display alert if no sample is added to the list
        if (samples.length === 0) {
            e.preventDefault();
            alert('Please add at least one sample to the list before submitting.');
            return;
        }

        //
        hiddenFieldsContainer.innerHTML = '';
        samples.forEach(s => {
            FIELD_NAMES.forEach(name => {
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = `${name}[]`;
                input.value = s[name] || '';
                hiddenFieldsContainer.appendChild(input);
            });
        });
    });

    initFields(fieldsContainer);
})