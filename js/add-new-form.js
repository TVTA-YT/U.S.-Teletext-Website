document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('submissionForm');
    const fieldsContainer = document.getElementById('sample-fields');
    const addBtn = document.getElementById('add-sample-btn');
    const summaryEl = document.getElementById('samples-summary');
    const hiddenFieldsContainer = document.getElementById('hidden-fields-container');

    const networkServices = {
        'ABC': ['ABCPLUS'],
        'CBS': ['ExtraVision'],
        'IPTV': ['IPTVAGIDS'],
        'KET': ['KETAGTEXT'],
        'MTV': ['Gemstar', 'StarSight'],
        'NBC': ['NBCTeletext'],
        'Nickelodeon': ['Gemstar', 'StarSight'],
        'PBS': ['Gemstar', 'SilentRadio', 'StarSight', 'WaveTop'],
        'TBS': ['Electra', 'Keyfax', 'SSSTeletext'],
        'WFLD': ['Keyfax'],
        'WGN': ['Virtext'],
        'WHA': ['WisInfotext-Text', 'WisInfotext-Teletext'],
        'WHYY': ['PENNTEXT'],
    };

    const AFFILIATE_NETWORKS = ['ABC', 'CBS', 'NBC', 'PBS'];

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
        'submissionFile'
    ];

    const FILE_FIELD_NAMES = ['submissionFile'];

    // Formspree's limits: 25 MB per file, 10 files per submission, 100 MB for the whole request.
    // The total is kept a little under 100 MB to leave room for the rest of the form
    const MB = 1024 * 1024;
    const MAX_FILE_BYTES = 25 * MB;
    const MAX_FILES = 10;
    const MAX_TOTAL_BYTES = 95 * MB;

    const statusEl = document.getElementById('submit-status');
    const progressEl = document.getElementById('upload-progress');
    const progressBar = progressEl.querySelector('.progress-bar');

    function formatSize(bytes) {
        return bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    }

    // Messages are announced by screen readers (role="status" in submissions.html)
    function showSubmitStatus(message, type = 'info', extra = null) {
        statusEl.className = message ? `alert alert-${type} mb-3` : 'mb-3';
        statusEl.replaceChildren(...(message ? [message] : []), ...(extra ? [extra] : []));
    }

    function setProgress(percent) {
        const value = Math.max(0, Math.min(100, Math.round(percent)));
        progressEl.hidden = false;
        progressEl.setAttribute('aria-valuenow', String(value));
        progressBar.style.width = `${value}%`;
        progressBar.textContent = `${value}%`;
    }

    function hideProgress() {
        setProgress(0);
        progressEl.hidden = true;
    }

    // Problems with a list of samples before anything is sent; returns a message, or null if it's fine
    function checkSampleLimits(list) {
        const files = list.map(s => s.submissionFile).filter(Boolean);
        const tooBig = files.find(file => file.size > MAX_FILE_BYTES);

        if (tooBig) {
            return `"${tooBig.name}" is ${formatSize(tooBig.size)}. Files can be up to 25 MB each. ` +
                'Please split them into smaller uploads if possible..';
        }

        if (files.length > MAX_FILES) {
            return `There are ${files.length} files. Up to ${MAX_FILES} can be sent at once, so please submit the rest separately.`;
        }

        const total = files.reduce((sum, file) => sum + file.size, 0);
        if (total > MAX_TOTAL_BYTES) {
            return `These files total ${formatSize(total)}. Up to 95 MB can be sent at once. Please submit them in smaller batches.`;
        }

        return null;
    }

    // Signed-in contributor with a confirmed name, or null (anyone can still submit without an account)
    let account = null;
    const nameInput = document.getElementById('sumbissionName');
    const nameHelp = document.getElementById('submissionNameHelp');
    const accountBar = document.getElementById('account-bar');

    // If there are multiple samples, they need to be kept in memory.
    let samples = [];
    // This will remain null unless a sample is being edited
    let editingIndex = null;

    // !
    function makeFileList(files) {
        const data = new DataTransfer();
        files.forEach(f => {
            if (f) data.items.add(f);
        });

        return data.files;
    }

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

        // If the user chooses "Other", disable the service options, remove the "required" attribute, hide the TBS hint, and show a new form input field for the name of the network
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

            // For PBS, TBS, and WHA-TV
            /*
            * TBS: Choose between Electra, Keyfax, or SSS Teletext.
            * PBS: Choose between Gemstar, Silent Radio, StarSight, or WaveTop.
            * WHA-TV: Choose between teletext or text versions of Wisconsin Infotext.
            * There is no default option since these networks used multiple services.
            */
        } else if (validServices.length > 1) {
            serviceSelect.value = validServices.includes(currentValue) ? currentValue : '';
            serviceSelect.disabled = false;
            hint.hidden = false;

        } else {
            serviceSelect.value = '';
            serviceSelect.disabled = true;
            hint.hidden = true;
        }
    }

    // If ABC, CBS, NBC, or PBS are chosen, enable the form affiliate input form field
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

            if (!el) {
                data[name] = FILE_FIELD_NAMES.includes(name) ? null : '';
                return;
            }

            if (FILE_FIELD_NAMES.includes(name)) {
                data[name] = el.files && el.files.length ? el.files[0] : null;
            } else {
                data[name] = el.value;
            }
        });
        return data;
    }

    // Take the JavaScript objects and write them back into the form
    function writeFields(data) {
        FIELD_NAMES.forEach(name => {
            const el = fieldsContainer.querySelector(`[name="${name}"], [name="${name}[]"]`);
            if (!el) return;

            if (FILE_FIELD_NAMES.includes(name)) {
                el.value = '';
                el.files = makeFileList(data[name] ? [data[name]] : []);
            } else {
                el.value = data[name] || '';
            }
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
            row.className = 'list-group-item d-flex justify-content-between align-items-center';

            const networkLabel = s.network === 'Other' ? s.otherNetwork : s.network;
            const serviceLabel = s.service === 'Other' || !s.service ? s.otherService : s.service;
            const fileLabel = s.submissionFile ? `${s.submissionFile.name} (${formatSize(s.submissionFile.size)})` : 'No file attached';

            // Sample row label (i.e. CBS - ExtraVision - "Program Title")
            row.innerHTML = `
            <span>Sample ${i + 1}: ${networkLabel} - ${serviceLabel} -- ${s.date} -- "${s.programTitle}" -- ${fileLabel}</span>
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

        // Catch files Formspree would refuse now, instead of after a long upload
        const updatedList = editingIndex !== null
            ? samples.map((s, i) => (i === editingIndex ? data : s))
            : [...samples, data];
        const problem = checkSampleLimits(updatedList);

        if (problem) {
            showSubmitStatus(problem, 'warning');
            return;
        }

        showSubmitStatus('');

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
    // They're remembered so they can be put back if the page stays open (e.g. after a failed upload)
    let strippedRequired = [];

    submitBtn.addEventListener('click', () => {
        if (samples.length === 0) return;

        strippedRequired = Array.from(fieldsContainer.querySelectorAll('[required]'));
        strippedRequired.forEach(el => {
            el.required = false;
        });
    });

    function restoreRequired() {
        strippedRequired.forEach(el => { el.required = true; });
        strippedRequired = [];
    }

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

    /* CONTRIBUTOR ACCOUNTS */

    // Show who is signed in and, if their name is confirmed, fill in and lock the uploader name field
    async function initAccount() {
        if (!window.NatAccount) return;
        const { getMe, signOut, el } = window.NatAccount;
        const me = await getMe();

        if (!me.loggedIn) {
            accountBar.replaceChildren(el('p', { className: 'mb-0 text-center' }, [
                'Contributed before? ',
                el('a', { href: 'login.html?next=submissions.html' }, 'Sign in'),
                ' to have your name filled in and follow your submissions on ',
                el('a', { href: 'my-submissions.html' }, 'My Submissions'),
                '. An account is optional.'
            ]));
            return;
        }

        const signOutBtn = el('button', { type: 'button', className: 'btn btn-link p-0 align-baseline' }, 'Sign out');
        signOutBtn.addEventListener('click', async () => {
            await signOut();
            window.location.reload();
        });

        // Name not set up yet, or waiting for confirmation: the form works as before
        if (me.nameStatus !== 'active') {
            accountBar.replaceChildren(el('p', { className: 'mb-0 text-center' }, [
                `Signed in as ${me.email}. `,
                me.nameStatus === 'pending'
                    ? 'Your contributor name is awaiting confirmation, so please type it below for now. '
                    : el('a', { href: 'login.html?next=submissions.html' }, 'Finish setting up your contributor name.'),
                ' ',
                signOutBtn
            ]));
            return;
        }

        account = me;

        accountBar.replaceChildren(el('p', { className: 'mb-0 text-center' }, [
            'Signed in as ',
            el('strong', { text: me.name }),
            me.anonymous ? ' (credited as Anonymous)' : '',
            '. ',
            el('a', { href: 'my-submissions.html' }, 'My Submissions'),
            ' · ',
            signOutBtn
        ]));

        // "Anonymous" or the contributor name, decided by the account's setting.
        // defaultValue keeps it in place when "Reset Fields" is pressed
        const credit = me.creditName ?? me.name;
        nameInput.value = credit;
        nameInput.defaultValue = credit;
        nameInput.readOnly = true;
        nameHelp.textContent = me.anonymous
            ? 'You\'ve chosen to stay anonymous, so your samples are credited as "Anonymous". You can change this on the My Submissions page.'
            : 'Filled in from your account. To be credited as "Anonymous" instead, change it on the My Submissions page.';
    }

    // The details of one sample as stored in the account's submission log (the file itself only goes to Formspree)
    function toLogEntry(s) {
        return {
            network: s.network === 'Other' ? s.otherNetwork : s.network,
            service: s.service || s.otherService,
            date: s.date,
            programTitle: s.programTitle,
            tapeType: s.tapeType,
            tapeSpeed: s.tapeSpeed,
            fileName: s.submissionFile ? s.submissionFile.name : ''
        };
    }

    /* SENDING TO FORMSPREE */

    // Sends the form to Formspree in the background, with upload progress.
    // Resolves to { ok, status, message } and never throws
    function sendToFormspree(formData) {
        return new Promise(resolve => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', form.action);

            // Asks Formspree for a JSON answer instead of its "thank you" page
            xhr.setRequestHeader('Accept', 'application/json');

            xhr.upload.addEventListener('progress', event => {
                if (event.lengthComputable) setProgress((event.loaded / event.total) * 100);
            });

            xhr.addEventListener('load', () => {
                let body = {};
                try { body = JSON.parse(xhr.responseText || '{}'); } catch { /* Cloudflare error pages aren't JSON */ }

                const formspreeMessage = Array.isArray(body.errors)
                    ? body.errors.map(error => error.message).filter(Boolean).join(' ')
                    : (body.error || '');

                resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, message: formspreeMessage });
            });

            // No answer at all: offline, or the upload was cut off (often because it was too large or too slow)
            xhr.addEventListener('error', () => resolve({ ok: false, status: 0, message: '' }));
            xhr.addEventListener('timeout', () => resolve({ ok: false, status: 0, message: '' }));

            xhr.send(formData);
        });
    }

    // A clear explanation for each way Formspree can refuse an upload
    function failureMessage(result) {
        if (result.status === 413) {
            return 'The uploaded file(s) is/are too large to be processed by the backend. Please submit fewer or smaller files at a time (up to 25 MB each, 95 MB in total).';
        }
        if (result.status === 429) {
            return 'Too many submissions were sent in a short time. Please wait a few minutes and try again.';
        }
        if (result.status === 0) {
            return 'The upload didn\'t finish. Check your connection and try again. Large uploads on slow connections can time out. Try submitting fewer files at a time.';
        }
        if (result.status === 403 && !result.message) {
            return 'The anti-spam check didn\'t pass. Please complete the check above the Submit button again and resubmit.';
        }

        const detail = result.message ? `: ${result.message.trim().replace(/[.!?]?$/, '.')}` : '.';
        return `The submission couldn't be sent${detail} Please try again.`;
    }

    // Single-use anti-spam token: needs a fresh one after every attempt
    function resetTurnstile() {
        try { window.turnstile?.reset(); } catch { /* widget not on the page */ }
    }

    function finishAttempt() {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Form';
        restoreRequired();
        resetTurnstile();
    }

    // Stop form submission if there are no samples
    form.addEventListener('submit', async (e) => {
        // Sent in the background (below), so the page stays open and can report the result
        e.preventDefault();

        // Display alert if no sample is added to the list
        if (samples.length === 0) {
            restoreRequired();
            alert('Please add at least one sample to the list before submitting.');
            return;
        }

        const problem = checkSampleLimits(samples);
        if (problem) {
            restoreRequired();
            showSubmitStatus(problem, 'warning');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting…';
        showSubmitStatus('Uploading your submission. Please keep this page open until it finishes.', 'info');
        setProgress(0);

        hiddenFieldsContainer.innerHTML = '';
        samples.forEach(s => {
            FIELD_NAMES.forEach(name => {
                if (FILE_FIELD_NAMES.includes(name)) {
                    const fileInput = document.createElement("input");
                    fileInput.type = "file";
                    fileInput.name = `${name}[]`;
                    fileInput.hidden = true;
                    fileInput.files = makeFileList(s[name] ? [s[name]] : []);
                    hiddenFieldsContainer.appendChild(fileInput);
                } else {
                    const input = document.createElement('input');
                    input.type = 'hidden';
                    input.name = `${name}[]`;
                    input.value = s[name] || '';
                    hiddenFieldsContainer.appendChild(input);
                }
            });
        });

        // Signed in: reserve a reference code on the account first. It stays hidden ("uploading")
        // until Formspree accepts the upload. A failure here never blocks the submission itself
        let logged = null;

        if (account) {
            const result = await window.NatAccount.post('/api/auth/submissions', { samples: samples.map(toLogEntry) });
            logged = result.ok ? result : null;

            // The reference code and verified name are included in the Formspree email so it can be matched to the account
            // accountName is the real contributor name, so you can tell who sent an "Anonymous" submission.
            // creditAs is what to put in "Recovered By" when it's added to the archive
            const extras = {
                submissionRef: logged ? logged.ref : 'not recorded',
                accountName: logged ? logged.name : account.name,
                creditAs: logged ? logged.creditName : (account.creditName ?? account.name)
            };
            Object.entries(extras).forEach(([name, value]) => {
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = name;
                input.value = value;
                hiddenFieldsContainer.appendChild(input);
            });
        }

        // Everything in the form, including the hidden fields above and the anti-spam token
        const sent = await sendToFormspree(new FormData(form));
        hideProgress();

        if (!sent.ok) {
            // Nothing reached Formspree, so remove the reserved entry; the list stays filled in to try again
            if (logged) await window.NatAccount.post('/api/auth/submissions/cancel', { ref: logged.ref });
            showSubmitStatus(failureMessage(sent), 'danger');
            finishAttempt();
            return;
        }

        // Formspree has it: make it visible on My Submissions
        if (logged) await window.NatAccount.post('/api/auth/submissions/confirm', { ref: logged.ref });

        const count = samples.length === 1 ? '1 sample' : `${samples.length} samples`;
        const confirmation = logged && window.NatAccount
            ? window.NatAccount.el('span', {}, [
                ` Your reference code is ${logged.ref}. You can follow it on `,
                window.NatAccount.el('a', { href: 'my-submissions.html' }, 'My Submissions'),
                '.'
            ])
            : null;

        showSubmitStatus(`Your submission (${count}) was received.`, 'success', confirmation);

        // Start fresh; the signed-in name stays filled in (its defaultValue is the account name)
        samples = [];
        editingIndex = null;
        addBtn.textContent = 'Add to List';
        hiddenFieldsContainer.innerHTML = '';
        form.reset();
        clearFields();
        renderSummary();
        finishAttempt();
        statusEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    initFields(fieldsContainer);
    initAccount();
})