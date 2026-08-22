document.addEventListener('DOMContentLoaded', () => {
  const tapeTypeSelect = document.getElementById('tapeType');
  const tapeSpeedSelect = document.getElementById('tapeSpeed');

  const betamaxGroup = tapeSpeedSelect.querySelector('optgroup[label="Betamax"]');
  const vhsGroup = tapeSpeedSelect.querySelector('optgroup[label="VHS"]');

  function updateTapeSpeedOptions() {
    const tapeType = tapeTypeSelect.value;

    // Whatever was previously picked may no longer be valid - reset it.
    tapeSpeedSelect.value = '';

    if (tapeType === 'VHS') {
      betamaxGroup.hidden = true;
      betamaxGroup.disabled = true;
      vhsGroup.hidden = false;
      vhsGroup.disabled = false;

    } else if (tapeType === 'Betamax') {
      vhsGroup.hidden = true;
      vhsGroup.disabled = true;
      betamaxGroup.hidden = false;
      betamaxGroup.disabled = false;

    } else {
      // No tape format chosen yet; disable the entire speed dropdown until the user picks a format first.
      betamaxGroup.hidden = false;
      betamaxGroup.disabled = true;
      vhsGroup.hidden = false;
      vhsGroup.disabled = true;
    }
  }

  // Run once on page load as well, in case the browser restored a previous selection (e.g. after a back-navigation) without firing 'change'.
  // This applies to all called functions in the script
  updateTapeSpeedOptions();
  tapeTypeSelect.addEventListener('change', updateTapeSpeedOptions);

  // * Teletext service form field auto-fill, which is tied to the network selection *

  const networkSelect = document.getElementById('network');
  const serviceSelect = document.getElementById('service'); // This is the visible field
  const serviceHiddenInput = document.getElementById('serviceHidden'); // This is what actually submits the value

  const allTeletextOptions = Array.from(serviceSelect.options);
  const tbsServiceHint = document.getElementById("hint")

  const networkServices = {
    'ABC': ['ABCPLUS'],
    'CBS': ['ExtraVision'],
    'KET': ['KETAGTEXT'],
    'NBC': ['NBCTeletext'],
    'TBS': ['Electra', 'Keyfax']
  };

  function updateTextService() {
    const validServices = networkServices[networkSelect.value] || [];

    // Show only the options valid for the chosen network; hide the rest.
    allTeletextOptions.forEach(opt => {
      opt.hidden = !validServices.includes(opt.value);
    });

    if (validServices.length === 1) {
      // ABC, CBS, KET, or NBC: exactly one valid service — auto-select it and lock the field.
      serviceSelect.value = validServices[0];
      serviceSelect.disabled = true;
      tbsServiceHint.hidden = true;

    } else if (validServices.length > 1) {
      // TBS: let the visitor choose between Electra and Keyfax.
      // There is no default option since TBS used both services.
      serviceSelect.value = '';
      serviceSelect.disabled = false;
      tbsServiceHint.hidden = false;

    } else {
      // No network chosen yet.
      serviceSelect.value = '';
      serviceSelect.disabled = true;
      tbsServiceHint.hidden = true;
    }

    serviceHiddenInput.value = serviceSelect.value;
  }

  updateTextService();
  networkSelect.addEventListener('change', updateTextService);


  // Enable station affiliate field only for ABC, CBS, and NBC options
  const affiliateInput = document.getElementById('affiliate');
  const AFFILIATE_NETWORKS = ['ABC', 'CBS', 'NBC'];

  function updateAffiliateField() {
    const isEnabled = AFFILIATE_NETWORKS.includes(networkSelect.value);

    affiliateInput.disabled = !isEnabled;

    if (!isEnabled) {
      affiliateInput.value = '';
    }
  }

  updateAffiliateField();
  networkSelect.addEventListener('change', updateAffiliateField)

  // Keep the hidden mirror in sync whenever the visitor picks between Electra/Keyfax themselves (this is only relevant while the select is enabled).
  serviceSelect.addEventListener('change', () => {
    serviceHiddenInput.value = serviceSelect.value;
    tbsServiceHint.hidden = serviceSelect.value !== '';
  });

  // This is needed because, when resetting the form, the teletext service field doesn't clear
  const form = networkSelect.closest("form");
  if (form) {
    form.addEventListener('reset', () => {
      setTimeout(() => {
        updateTapeSpeedOptions();
        updateTextService();
        updateAffiliateField();
      }, 0);
    })
  }
});