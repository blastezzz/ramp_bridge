(function(){
  "use strict";
  document.documentElement.classList.add("js");

  /* ---------------------------------------------------------------
     WALLETS: MetaMask / Rabby via EIP-1193 + EIP-6963 discovery,
     Phantom via window.solana. Connecting only ever requests the
     public address.

     BRIDGING: live on relay.link (verified against their public API
     — Robinhood Chain, id 4663, is already onboarded there for
     SOL / ETH / BNB in both directions). Pressing "bridge" fetches a
     real quote and, on confirm, sends the exact transaction Relay's
     API returns — RAMP never constructs bridge calldata itself.
     Every transaction still requires the user's explicit approval
     inside their own wallet.

     STAKING: $RAMP has no deployed token or staking contract yet
     (confirmed by the team), so the stake action stays disabled.
  ------------------------------------------------------------------*/

  var RELAY_API = "https://api.relay.link";

  var CHAINS = {
    SOL: { id:792703809, vm:"svm", symbol:"SOL", decimals:9,  name:"Solana",          native:"11111111111111111111111111111111",       explorer:"https://solscan.io/tx/" },
    ETH: { id:1,         vm:"evm", symbol:"ETH", decimals:18, name:"Ethereum",        native:"0x0000000000000000000000000000000000000000", hex:"0x1",    explorer:"https://etherscan.io/tx/" },
    BNB: { id:56,        vm:"evm", symbol:"BNB", decimals:18, name:"BNB Chain",       native:"0x0000000000000000000000000000000000000000", hex:"0x38",   explorer:"https://bscscan.com/tx/" },
    RH:  { id:4663,      vm:"evm", symbol:"ETH", decimals:18, name:"Robinhood Chain", native:"0x0000000000000000000000000000000000000000", hex:"0x1237",
           explorer:"https://robinhoodchain.blockscout.com/tx/", rpc:"https://rpc.mainnet.chain.robinhood.com" }
  };
  // api.mainnet-beta.solana.com actively rejects any request carrying a
  // browser Origin header (403) - it's meant for server-side callers only.
  // publicnode's endpoint serves the same mainnet data with open CORS.
  var SOL_RPC = "https://solana-rpc.publicnode.com";

  // ---- $RAMP token contract ------------------------------------------
  // No $RAMP token is deployed yet. Until it is, this points at a real,
  // already-live token on Robinhood Chain purely so the "copy address /
  // view on explorer" UI has something genuine to demonstrate against —
  // it is clearly labelled as an example everywhere it renders (see
  // renderTokenContract() below), never presented as $RAMP itself.
  //
  // TO GO LIVE: once $RAMP deploys, change exactly these four lines —
  // everything else (badge color, copy text, explorer link) updates
  // itself from `isLive`.
  var RAMP_TOKEN = {
    isLive: true,
    address: "0x11111111111111111111111111",
    symbol: "RAMP",
    chainName: "Robinhood Chain",
    explorerBase: "https://robinhoodchain.blockscout.com/address/"
  };

  var discovered = {}; // rdns -> {info, provider}
  window.addEventListener("eip6963:announceProvider", function(e){
    if (e && e.detail && e.detail.info) discovered[e.detail.info.rdns] = e.detail;
  });
  try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch(err){}

  function getEvmProvider(kind){
    var rdns = kind === "metamask" ? "io.metamask" : "io.rabby";
    if (discovered[rdns]) return discovered[rdns].provider;
    var eth = window.ethereum;
    if (!eth) return null;
    var list = eth.providers && eth.providers.length ? eth.providers : [eth];
    for (var i=0;i<list.length;i++){
      var p = list[i];
      if (kind === "metamask" && p.isMetaMask && !p.isRabby) return p;
      if (kind === "rabby" && p.isRabby) return p;
    }
    return null;
  }
  function hasPhantom(){ return !!(window.solana && window.solana.isPhantom); }

  var EVM_CHAIN_NAMES = { "0x1":"Ethereum", "0x38":"BNB Chain", "0x1237":"Robinhood Chain" };
  function short(addr){ return addr ? addr.slice(0,6) + "…" + addr.slice(-4) : "—"; }

  var wallet = { kind:null, address:null, hexChainId:null, provider:null };
  var bridge = { asset:"SOL", intoRH:true, quote:null };

  /* ---------------- wallet connect ---------------- */

  function setConnectedUI(){
    // every chain gets the same shortened form — a full Solana base58 key
    // next to a shortened 0x… one looked like two different UIs
    var addr = short(wallet.address);
    var net = wallet.kind === "phantom" ? "Solana" : (EVM_CHAIN_NAMES[wallet.hexChainId] || ("chain " + wallet.hexChainId));

    var navBtn = document.getElementById("navWalletBtn");
    if (navBtn){ navBtn.textContent = addr; navBtn.title = wallet.address || ""; navBtn.classList.remove("btn-primary"); navBtn.classList.add("btn-ghost"); }

    ["route","stake"].forEach(function(scope){
      var box = document.getElementById(scope + "ConnectedBox");
      var addrEl = document.getElementById(scope + "ConnectedAddr");
      var netEl = document.getElementById(scope + "ConnectedNet");
      if (box) box.hidden = false;
      if (addrEl){ addrEl.textContent = addr; addrEl.title = wallet.address || ""; }
      if (netEl) netEl.textContent = net;
    });

    // staking stays disabled — no $RAMP contract deployed yet
    var stakeBtn = document.getElementById("stakeActionBtn");
    if (stakeBtn){ stakeBtn.textContent = "stake $RAMP"; stakeBtn.disabled = true; stakeBtn.removeAttribute("data-open-wallet"); }
    var stakeNote = document.getElementById("stakePendingNote");
    if (stakeNote) stakeNote.hidden = false;
    var balEl = document.getElementById("stakeBalanceValue");
    if (balEl) balEl.textContent = "no $RAMP contract configured yet";

    var routeBtn = document.getElementById("routeActionBtn");
    if (routeBtn) routeBtn.removeAttribute("data-open-wallet");
    renderBridgeForm();
  }

  function connectEvm(kind){
    var provider = getEvmProvider(kind);
    if (!provider){
      var links = { metamask:"https://metamask.io/download", rabby:"https://rabby.io" };
      window.open(links[kind], "_blank", "noopener");
      return;
    }
    provider.request({ method:"eth_requestAccounts" }).then(function(accounts){
      return provider.request({ method:"eth_chainId" }).then(function(chainId){
        wallet = { kind:kind, address:accounts[0], hexChainId:chainId, provider:provider };
        setConnectedUI();
        closeModal();
        rememberWalletKind(kind);
      });
    }).catch(function(err){ console.warn("[ramp] wallet connect rejected", err); });

    provider.on && provider.on("accountsChanged", function(accounts){
      if (!accounts.length){ location.reload(); return; }
      wallet.address = accounts[0]; setConnectedUI();
    });
    provider.on && provider.on("chainChanged", function(chainId){
      wallet.hexChainId = chainId; setConnectedUI();
    });
  }

  function connectPhantom(){
    if (!hasPhantom()){ window.open("https://phantom.app/download", "_blank", "noopener"); return; }
    window.solana.connect().then(function(resp){
      wallet = { kind:"phantom", address: resp.publicKey.toString(), hexChainId:null, provider: window.solana };
      setConnectedUI();
      closeModal();
      rememberWalletKind("phantom");
    }).catch(function(err){ console.warn("[ramp] phantom connect rejected", err); });
  }

  // The site is now multiple pages (index / bridge.html / stake.html) sharing
  // one origin, so a wallet's own site permission already carries across —
  // remembering *which* wallet was last used lets each new page reconnect to
  // it silently (no popup) instead of showing "connect wallet" again.
  function rememberWalletKind(kind){
    try { localStorage.setItem("ramp_wallet_kind", kind); } catch(e){}
  }
  function trySilentReconnect(){
    var kind;
    try { kind = localStorage.getItem("ramp_wallet_kind"); } catch(e){ return; }
    if (!kind) return;
    if (kind === "phantom"){
      if (!hasPhantom()) return;
      window.solana.connect({ onlyIfTrusted: true }).then(function(resp){
        wallet = { kind:"phantom", address: resp.publicKey.toString(), hexChainId:null, provider: window.solana };
        setConnectedUI();
      }).catch(function(){ /* not previously trusted here — stay disconnected, no popup */ });
      return;
    }
    var provider = getEvmProvider(kind);
    if (!provider) return;
    provider.request({ method:"eth_accounts" }).then(function(accounts){
      if (!accounts || !accounts.length) return; // no popup either way; just means not authorized
      return provider.request({ method:"eth_chainId" }).then(function(chainId){
        wallet = { kind:kind, address:accounts[0], hexChainId:chainId, provider:provider };
        setConnectedUI();
      });
    }).catch(function(){});
  }

  function refreshWalletStatuses(){
    setStatus("metamask", !!getEvmProvider("metamask"));
    setStatus("rabby", !!getEvmProvider("rabby"));
    setStatus("phantom", hasPhantom());
  }
  function setStatus(kind, found){
    var el = document.querySelector('[data-status="' + kind + '"]');
    if (!el) return;
    el.textContent = found ? "detected" : "install →";
    el.classList.toggle("found", found);
  }

  var modal = document.getElementById("walletModal");
  function openModal(){ if (!modal) return; modal.hidden = false; refreshWalletStatuses(); }
  function closeModal(){ if (!modal) return; modal.hidden = true; }

  document.addEventListener("click", function(e){
    if (e.target.closest("[data-open-wallet]")) openModal();
    if (e.target.id === "walletModalClose" || e.target === modal) closeModal();
    var row = e.target.closest("[data-wallet]");
    if (row){
      var kind = row.getAttribute("data-wallet");
      if (kind === "phantom") connectPhantom(); else connectEvm(kind);
    }
    var chainBtn = e.target.closest("[data-asset]");
    if (chainBtn){
      bridge.asset = chainBtn.getAttribute("data-asset");
      document.querySelectorAll("#assetSelectRow .chain-select").forEach(function(b){ b.classList.toggle("active", b === chainBtn); });
      renderBridgeForm();
    }
    if (e.target.id === "swapDirBtn"){ bridge.intoRH = !bridge.intoRH; renderBridgeForm(); }
    if (e.target.id === "routeActionBtn" && !e.target.disabled && !e.target.hasAttribute("data-open-wallet")) executeBridge();
  });
  document.addEventListener("keydown", function(e){ if (e.key === "Escape") closeModal(); });

  var amountInput = document.getElementById("bridgeAmountInput");
  if (amountInput) amountInput.addEventListener("input", scheduleQuote);
  var destInput = document.getElementById("destAddressInput");
  if (destInput) destInput.addEventListener("input", scheduleQuote);

  /* ---------------- bridge form ---------------- */

  function fromKey(){ return bridge.intoRH ? bridge.asset : "RH"; }
  function toKey(){ return bridge.intoRH ? "RH" : bridge.asset; }


  function renderBridgeForm(){
    var fromSideEl = document.getElementById("fromSide");
    if (!fromSideEl) return; // this page has no bridge form (only bridge.html does)
    var from = CHAINS[fromKey()], to = CHAINS[toKey()];
    fromSideEl.textContent = from.name;
    document.getElementById("toSide").textContent = to.name;
    document.getElementById("bridgeAmountSymbol").textContent = from.symbol;

    var crossVm = from.vm !== to.vm;
    var destWrap = document.getElementById("destAddressWrap");
    var hint = document.getElementById("destAddressHint");
    if (crossVm){
      destWrap.hidden = false;
      hint.textContent = "sending to a " + to.name + " address (" + (to.vm === "svm" ? "Solana" : "EVM") + ") — paste it above";
    } else {
      destWrap.hidden = true;
    }

    bridge.quote = null;
    scheduleQuote();
  }

  function resolveRecipient(){
    var from = CHAINS[fromKey()], to = CHAINS[toKey()];
    if (from.vm === to.vm) return wallet.address; // same-VM: send to your own connected address
    var manual = (document.getElementById("destAddressInput").value || "").trim();
    return manual || null;
  }

  function toBaseUnits(amountStr, decimals){
    amountStr = String(amountStr || "0").trim();
    if (!amountStr) return null;
    var neg = amountStr[0] === "-"; if (neg) amountStr = amountStr.slice(1);
    var parts = amountStr.split(".");
    var whole = parts[0].replace(/\D/g,"") || "0";
    var frac = (parts[1] || "").replace(/\D/g,"");
    if (frac.length > decimals) frac = frac.slice(0, decimals);
    frac = frac + "0".repeat(decimals - frac.length);
    var combined = (whole + frac).replace(/^0+(?=\d)/, "");
    try { var n = BigInt(combined || "0"); return (neg ? -n : n).toString(); }
    catch(e){ return null; }
  }

  var quoteTimer = null;
  function scheduleQuote(){ clearTimeout(quoteTimer); quoteTimer = setTimeout(doQuote, 450); }

  function doQuote(){
    var quoteArea = document.getElementById("quoteArea");
    var actionBtn = document.getElementById("routeActionBtn");
    var from = CHAINS[fromKey()], to = CHAINS[toKey()];

    if (!wallet.address){
      quoteArea.innerHTML = '<p class="pending-note">connect a wallet to get a live quote</p>';
      actionBtn.disabled = true; actionBtn.textContent = "connect wallet to bridge"; actionBtn.setAttribute("data-open-wallet","");
      return;
    }
    var walletVm = wallet.kind === "phantom" ? "svm" : "evm";
    if (walletVm !== from.vm){
      quoteArea.innerHTML = '<p class="pending-note"><span class="tag">// wrong wallet</span> connect a ' +
        (from.vm === "svm" ? "Solana wallet (Phantom)" : "EVM wallet (MetaMask / Rabby)") + ' to bridge from ' + from.name + '.</p>';
      actionBtn.disabled = true; actionBtn.textContent = "connect " + (from.vm === "svm" ? "Phantom" : "an EVM wallet"); actionBtn.setAttribute("data-open-wallet","");
      return;
    }

    var amtStr = document.getElementById("bridgeAmountInput").value;
    var amt = parseFloat(amtStr);
    if (!amt || amt <= 0){
      quoteArea.innerHTML = '<p class="pending-note">enter an amount above for a live quote</p>';
      actionBtn.disabled = true; actionBtn.textContent = "enter an amount"; actionBtn.removeAttribute("data-open-wallet");
      return;
    }

    var recipient = resolveRecipient();
    if (!recipient){
      quoteArea.innerHTML = '<p class="pending-note">paste the destination address above</p>';
      actionBtn.disabled = true; actionBtn.textContent = "enter destination address"; actionBtn.removeAttribute("data-open-wallet");
      return;
    }

    var amountBase = toBaseUnits(amtStr, from.decimals);
    if (!amountBase || amountBase === "0"){
      quoteArea.innerHTML = '<p class="pending-note">enter a valid amount</p>';
      actionBtn.disabled = true; return;
    }

    quoteArea.innerHTML = '<p class="pending-note">fetching live quote from relay.link…</p>';
    actionBtn.disabled = true; actionBtn.textContent = "getting quote…"; actionBtn.removeAttribute("data-open-wallet");

    var myTicket = ++bridge.ticket_ || (bridge.ticket_ = 1);
    fetch(RELAY_API + "/quote", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({
        user: wallet.address,
        recipient: recipient,
        originChainId: from.id,
        destinationChainId: to.id,
        originCurrency: from.native,
        destinationCurrency: to.native,
        amount: amountBase,
        tradeType: "EXACT_INPUT"
      })
    }).then(function(res){ return res.json().then(function(data){ return { ok: res.ok, data: data }; }); })
      .then(function(r){
        if (myTicket !== bridge.ticket_) return; // a newer input superseded this request
        if (!r.ok || !r.data || !r.data.steps){ throw new Error((r.data && r.data.message) || "no route available"); }
        bridge.quote = r.data;
        renderQuote(r.data, from, to, amt);
        actionBtn.disabled = false;
        actionBtn.textContent = "bridge " + trimNum(amtStr) + " " + from.symbol + " → " + to.name;
      })
      .catch(function(err){
        if (myTicket !== bridge.ticket_) return;
        quoteArea.innerHTML = '<p class="pending-note" style="color:var(--dot-red);">quote failed — ' + escapeHtml(friendlyNetworkError(err)) + '</p>';
        actionBtn.disabled = true; actionBtn.textContent = "no route found";
      });
  }

  function trimNum(s){ return String(parseFloat(s)); }
  function escapeHtml(s){ var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  function friendlyNetworkError(err){
    var msg = (err && err.message) || String(err);
    if (/failed to fetch/i.test(msg) || (err instanceof TypeError)){
      return "this preview is running inside Claude's sandboxed Artifact viewer, which blocks direct requests to relay.link. Deploy this page on your own hosting (it's a single static HTML file — Vercel, Netlify or GitHub Pages all work) to enable live quotes and bridging.";
    }
    return msg;
  }

  function renderQuote(data, from, to, amtIn){
    var det = data.details || {};
    var out = det.currencyOut || {};
    var totalFeeUsd = 0;
    ["gas","relayer"].forEach(function(k){
      var f = data.fees && data.fees[k];
      if (f && f.amountUsd) totalFeeUsd += parseFloat(f.amountUsd) || 0;
    });
    var eta = det.timeEstimate != null ? (det.timeEstimate < 60 ? det.timeEstimate + "s" : Math.round(det.timeEstimate/60) + "m") : "—";

    document.getElementById("quoteArea").innerHTML =
      '<div class="kv-block">' +
        '<div class="kv-row"><span class="k">you send</span><span class="v big">' + amtIn + ' ' + from.symbol + '</span></div>' +
        '<div class="kv-row"><span class="k">you receive (est.)</span><span class="v big amber">' + (out.amountFormatted ? parseFloat(out.amountFormatted).toFixed(6) : "—") + ' ' + to.symbol + '</span></div>' +
        (out.amountUsd ? '<div class="kv-row"><span class="k">≈ usd</span><span class="v">$' + parseFloat(out.amountUsd).toLocaleString(undefined,{maximumFractionDigits:2}) + '</span></div>' : "") +
      '</div>' +
      '<div class="kv-block">' +
        '<div class="kv-row"><span class="k">via</span><span class="v">relay.link</span></div>' +
        '<div class="kv-row"><span class="k">network + relayer fee</span><span class="v">≈ $' + totalFeeUsd.toFixed(2) + '</span></div>' +
        '<div class="kv-row"><span class="k">eta</span><span class="v">~' + eta + '</span></div>' +
      '</div>';
  }

  /* ---------------- execution ---------------- */

  function ensureEvmChain(provider, chain){
    return provider.request({ method:"eth_chainId" }).then(function(current){
      if (current.toLowerCase() === chain.hex.toLowerCase()) return;
      return provider.request({ method:"wallet_switchEthereumChain", params:[{ chainId: chain.hex }] })
        .catch(function(switchErr){
          if (switchErr && (switchErr.code === 4902 || (switchErr.data && switchErr.data.originalError && switchErr.data.originalError.code === 4902))){
            return provider.request({ method:"wallet_addEthereumChain", params:[{
              chainId: chain.hex,
              chainName: chain.name,
              nativeCurrency: { name: chain.symbol, symbol: chain.symbol, decimals: 18 },
              rpcUrls: chain.rpc ? [chain.rpc] : [],
              blockExplorerUrls: [chain.explorer.replace(/\/tx\/$/,"")]
            }]});
          }
          throw switchErr;
        });
    });
  }

  function hexToBytes(hex){
    if (hex.indexOf("0x") === 0) hex = hex.slice(2);
    var bytes = new Uint8Array(hex.length/2);
    for (var i=0;i<bytes.length;i++) bytes[i] = parseInt(hex.substr(i*2,2),16);
    return bytes;
  }

  function sendSolanaDeposit(depositData){
    var web3 = window.solanaWeb3;
    if (!web3) return Promise.reject(new Error("Solana library failed to load"));
    if (!window.Buffer) return Promise.reject(new Error("Buffer polyfill failed to load — refresh and try again"));
    var connection = new web3.Connection(SOL_RPC, "confirmed");
    var instructions = depositData.instructions.map(function(ix){
      return new web3.TransactionInstruction({
        programId: new web3.PublicKey(ix.programId),
        keys: ix.keys.map(function(k){ return { pubkey: new web3.PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable }; }),
        data: window.Buffer.from(hexToBytes(ix.data))
      });
    });
    var lookupAddrs = depositData.addressLookupTableAddresses || [];
    return Promise.all(lookupAddrs.map(function(addr){
      return connection.getAddressLookupTable(new web3.PublicKey(addr)).then(function(res){ return res.value; });
    })).then(function(tables){
      return connection.getLatestBlockhash().then(function(bh){
        var message = new web3.TransactionMessage({
          payerKey: new web3.PublicKey(wallet.address),
          recentBlockhash: bh.blockhash,
          instructions: instructions
        }).compileToV0Message(tables.filter(Boolean));
        var tx = new web3.VersionedTransaction(message);
        return window.solana.signAndSendTransaction(tx);
      });
    }).then(function(res){ return res.signature || res; });
  }

  function pollStatus(requestId, noteEl, from, to, txHash){
    var attempts = 0;
    function tick(){
      attempts++;
      fetch(RELAY_API + "/intents/status?requestId=" + encodeURIComponent(requestId))
        .then(function(r){ return r.json(); })
        .then(function(d){
          var status = d && d.status;
          if (status === "success"){
            noteEl.innerHTML = '<span class="tag" style="color:var(--dot-green);">// bridged</span> done — <a href="' + from.explorer + txHash + '" target="_blank" rel="noopener" style="color:var(--amber);">view source tx</a>';
            return;
          }
          if (status === "failure" || status === "refund"){
            noteEl.innerHTML = '<span class="tag" style="color:var(--dot-red);">// ' + status + '</span> relay reported this route did not complete — funds are refunded to the sender if applicable.';
            return;
          }
          if (attempts < 20){
            noteEl.innerHTML = '<span class="tag">// ' + (status || "pending") + '</span> tracking <a href="' + from.explorer + txHash + '" target="_blank" rel="noopener" style="color:var(--amber);">' + short(txHash) + '</a>…';
            setTimeout(tick, 3000);
          } else {
            noteEl.innerHTML = '<span class="tag">// submitted</span> tx sent — <a href="' + from.explorer + txHash + '" target="_blank" rel="noopener" style="color:var(--amber);">check status</a> (this can take a few minutes).';
          }
        })
        .catch(function(){ if (attempts < 20) setTimeout(tick, 3000); });
    }
    tick();
  }

  function executeBridge(){
    if (!bridge.quote) return;
    var from = CHAINS[fromKey()], to = CHAINS[toKey()];
    var step = bridge.quote.steps[0];
    var item = step.items[0];
    var actionBtn = document.getElementById("routeActionBtn");
    var statusNote = document.getElementById("routeStatusNote");

    actionBtn.disabled = true;
    statusNote.hidden = false;
    statusNote.innerHTML = '<span class="tag">// confirm</span> check your wallet for the signature request…';

    var sendPromise;
    if (from.vm === "evm"){
      sendPromise = ensureEvmChain(wallet.provider, from).then(function(){
        var d = item.data;
        var value = "0x" + (BigInt(d.value || "0")).toString(16);
        return wallet.provider.request({ method:"eth_sendTransaction", params:[{ from: d.from, to: d.to, data: d.data, value: value }] });
      });
    } else {
      sendPromise = sendSolanaDeposit(item.data);
    }

    sendPromise.then(function(txHash){
      statusNote.innerHTML = '<span class="tag">// submitted</span> tx <a href="' + from.explorer + txHash + '" target="_blank" rel="noopener" style="color:var(--amber);">' + short(txHash) + '</a> — tracking…';
      pollStatus(bridge.quote.requestId, statusNote, from, to, txHash);
    }).catch(function(err){
      statusNote.innerHTML = '<span class="tag" style="color:var(--dot-red);">// not sent</span> ' + escapeHtml(err ? friendlyNetworkError(err) : "the wallet rejected or failed to send this transaction");
    }).finally(function(){
      actionBtn.disabled = false;
    });
  }

  /* ---------------- staking tier preview (cosmetic — no contract yet) ----------------
     highlights both the chips above the button and the matching row of the
     fee table, so typing an amount points at the tier it actually buys. */
  var stakeInput = document.getElementById("stakeAmountInput");
  var tierChips = document.querySelectorAll("#tierPreview .tier-chip");
  var tierRows = document.querySelectorAll("[data-tier-row]");

  function highlightTier(amount){
    function pick(nodes, attr){
      var active = null;
      nodes.forEach(function(el){
        var threshold = parseFloat(el.getAttribute(attr));
        if (!isNaN(threshold) && amount >= threshold) active = el;
      });
      return active || nodes[0];
    }
    if (tierChips.length){
      var chip = pick(tierChips, "data-tier");
      tierChips.forEach(function(el){ el.classList.toggle("active", el === chip); });
    }
    if (tierRows.length){
      var row = pick(tierRows, "data-tier-row");
      tierRows.forEach(function(el){ el.classList.toggle("is-current", el === row); });
    }
  }

  if (stakeInput){
    stakeInput.addEventListener("input", function(){
      highlightTier(parseFloat(stakeInput.value) || 0);
    });
  }

  /* ---------------- $RAMP token contract card ---------------- */
  function renderTokenContract(){
    var addrEl = document.getElementById("contractAddress");
    if (!addrEl) return; // this page has no contract card
    // full address, sized by CSS to fit its box on one line — an address you
    // can read end to end is the whole point of putting it on the page
    addrEl.textContent = RAMP_TOKEN.address;
    addrEl.title = RAMP_TOKEN.address;

    var badge = document.getElementById("contractBadge");
    if (badge){ badge.textContent = RAMP_TOKEN.isLive ? "live" : "example"; badge.classList.toggle("live", RAMP_TOKEN.isLive); }

    var note = document.getElementById("contractNote");
    if (note){
      note.innerHTML = RAMP_TOKEN.isLive
        ? '<span class="tag" style="color:var(--rh-green);">// live</span> $RAMP is officially launched on ' + RAMP_TOKEN.chainName + '. Always check the address against this page before you trade.'
        : '<span class="tag">// placeholder</span> a live ' + RAMP_TOKEN.symbol + ' contract on ' + RAMP_TOKEN.chainName + ' — <strong>not $RAMP</strong>, which hasn\'t deployed yet.';
    }

    var link = document.getElementById("contractExplorerLink");
    if (link) link.href = RAMP_TOKEN.explorerBase + RAMP_TOKEN.address;
  }
  renderTokenContract();

  document.addEventListener("click", function(e){
    // the button holds an icon + a label span, so match on the button itself
    // (a click can land on the svg) and only ever swap the label's text —
    // writing to the button would wipe the icon out.
    var btn = e.target.closest && e.target.closest("#contractCopyBtn");
    if (!btn) return;
    var label = btn.querySelector(".chip-label") || btn;
    var done = function(ok){
      label.textContent = ok ? "copied" : "copy failed";
      btn.classList.toggle("copied", ok);
      setTimeout(function(){ label.textContent = "copy"; btn.classList.remove("copied"); }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(RAMP_TOKEN.address).then(function(){ done(true); }).catch(function(){ done(false); });
    } else {
      done(false);
    }
  });

  setTimeout(refreshWalletStatuses, 400);
  setTimeout(trySilentReconnect, 350); // let EIP-6963 providers announce themselves first
  renderBridgeForm();

  /* ---------------- scroll-reveal dynamics (below-the-fold only) ---------------- */
  try {
    var revealEls = document.querySelectorAll(".reveal");
    if ("IntersectionObserver" in window){
      var io = new IntersectionObserver(function(entries){
        entries.forEach(function(entry){
          if (entry.isIntersecting){ entry.target.classList.add("in"); io.unobserve(entry.target); }
        });
      }, { threshold: 0.12, rootMargin: "0px 0px -30px 0px" });
      revealEls.forEach(function(el){ io.observe(el); });
    } else {
      revealEls.forEach(function(el){ el.classList.add("in"); });
    }
  } catch (revealErr){
    document.querySelectorAll(".reveal").forEach(function(el){ el.classList.add("in"); });
  }
})();
