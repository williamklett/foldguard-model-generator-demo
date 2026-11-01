"use strict";
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const localPage = ["localhost","127.0.0.1"].includes(location.hostname);
const base = localPage ? location.origin : "http://127.0.0.1:8773";
let token = sessionStorage.getItem("foldguard-service-token") || "";
let connected = false, profiles = [], runs = [], checks = {}, stores = [], currentRun = null, activeProfile = null;
let polling = false, busy = false, selectedLoss = "", previousView = null;
const files = {train:null,test:null};
let summaryTimer, renderedResultRun = null, validationRevision = 0;
const datasetRevision = {train:0,test:0}, pendingFiles = {train:null,test:null};
let storageSplit = "train", storageSession = 0, storageRequest = 0, storageNext = null, storageRows = [], storageLoading = false;
let pairingWindow = null, pairingState = "", pairingTimer = null, importingDatasets = 0;
const randomID = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,"0")).join("");

function notice(message, error=false) {
  $("notice").textContent = message;
  $("notice").className = "notice" + (error ? " error" : "");
}
function clearNotice(){ $("notice").classList.add("hidden"); }
async function api(path, body, options={}) {
  const response = await fetch(base+path,{method:body === undefined ? "GET" : "POST",
    headers:{"Authorization":"Bearer "+token,...(body===undefined?{}:{"Content-Type":"application/json"})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(options.timeout || 120000)});
  if(options.blob){ if(!response.ok)throw new Error((await response.json()).error); return response.blob(); }
  const data = await response.json();
  if(!response.ok)throw new Error(data.error || "The request could not be completed.");
  return data;
}
function connectionUI(value) {
  connected=value;
  $("connection-dot").classList.toggle("online",value);
  $("side-dot").classList.toggle("online",value);
  $("connection-label").textContent=value?"Workspace connected":"Connect this computer";
  $("side-status").textContent=value?"Companion connected":"Companion offline";
  $("launch-run").disabled=!value||busy||importingDatasets>0||!!pendingFiles.train||!!pendingFiles.test;
  $("local-token-tools").classList.toggle("hidden",!localPage||!value);
}
function showConnection() {
  $("service-url").value=base;
  $("service-token").value=token;
  $("connection-dialog").showModal();
}
function changeView(name) {
  for(const view of ["builder","runs"])$(view+"-view").classList.toggle("hidden",view!==name);
  document.querySelectorAll("[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===name));
  $("page-title").textContent={builder:"Model Generator",runs:"Model runs"}[name];
  if(name==="runs")renderRuns();
}
function populateColumns() {
  const fields = files.train?.columns || files.test?.columns;
  if(!fields)return;
  const definitions=[
    ["sequence-column","",/^(sequence|protein_sequence|seq)$/i],
    ["label-column","",/^(label|annotation|class|target|origin|location)$/i],
    ["id-column","Generate IDs",/^(id|protein_id|accession)$/i],
    ["group-column","No group column",/^(family|family_taxid|group|component_id|cluster)$/i]];
  for(const [id,empty,pattern] of definitions){
    const select=$(id),current=select.value;
    select.innerHTML=(empty?`<option value="">${empty}</option>`:`<option value="">Choose a column</option>`)+fields.map(f=>`<option value="${esc(f)}">${esc(f)}</option>`).join("");
    select.value=fields.includes(current)?current:(fields.find(f=>pattern.test(f))||"");
  }
  if(!$("run-name").value&&$("label-column").value)$("run-name").placeholder=$("label-column").value+" · v1";
  scheduleSummary();
}
function datasetChanged() {
  validationRevision++;
  clearTimeout(summaryTimer);
  $("dataset-summary").classList.add("hidden");
  populateColumns();
}
function acceptDataset(split, data) {
  files[split]=data;
  $(split+"-filename").textContent=data.name;
  $(split+"-detail").textContent=data.rows.toLocaleString()+" proteins · "+data.columns.length+" columns";
  $(split+"-drop").classList.add("filled");
  datasetChanged();
}
async function uploadPending(split) {
  const entry=pendingFiles[split];
  if(!entry||!connected||entry.uploading)return;
  entry.uploading=true;connectionUI(connected);
  try{
    const text=await entry.file.text();
    if(pendingFiles[split]!==entry)return;
    const data=await api("/api/datasets/upload",{text,name:entry.file.name});
    if(pendingFiles[split]!==entry||datasetRevision[split]!==entry.revision)return;
    pendingFiles[split]=null;acceptDataset(split,data);
  }catch(error){if(pendingFiles[split]===entry){$(split+"-detail").textContent="Import failed · choose a file again";notice(error.message,true);pendingFiles[split]=null;}}
  finally{entry.uploading=false;connectionUI(connected);}
}
async function uploadPendingFiles(){await Promise.all(["train","test"].map(uploadPending));}
async function loadFile(split,file){
  if(!file)return;
  if(file.size>24*1024**2){notice("Choose a file smaller than 24 MB.",true);return;}
  const revision=++datasetRevision[split];
  files[split]=null;pendingFiles[split]={file,revision,uploading:false};datasetChanged();
  $(split+"-filename").textContent=file.name;
  $(split+"-detail").textContent=connected?"Importing table…":"Connect this computer to import this file";
  $(split+"-drop").classList.add("filled");clearNotice();await uploadPending(split);
}
function mapping(){return {sequence:$("sequence-column").value,label:$("label-column").value,id:$("id-column").value,group:$("group-column").value};}
function datasetPayload(){return {train_ref:files.train.id,test_ref:files.test.id,mapping:mapping()};}
function scheduleSummary(){validationRevision++;clearTimeout(summaryTimer);summaryTimer=setTimeout(validateSummary,300);}
async function validateSummary(){
  if(!connected||!files.train?.id||!files.test?.id||!mapping().sequence||!mapping().label)return;
  const revision=validationRevision;
  try{
    const data=await api("/api/validate",datasetPayload());
    if(revision!==validationRevision)return;
    $("dataset-summary").innerHTML=`<div class="summary-grid"><span><strong>${data.train_rows.toLocaleString()}</strong>training proteins</span><span><strong>${data.test_rows.toLocaleString()}</strong>test proteins</span><span><strong>${data.classes.length}</strong>classes</span></div><div>${data.group_disjoint?"✓ Supplied groups are disjoint":"No family/group holdout supplied"} · Exact train/test duplicates excluded</div><div class="warning-text">${data.homology_screened?"":"Sequence similarity between sets is not screened."}</div>`;
    $("dataset-summary").classList.remove("hidden");
  }catch(error){if(revision===validationRevision){$("dataset-summary").innerHTML=`<div class="warning-text">${esc(error.message)}</div>`;$("dataset-summary").classList.remove("hidden");}}
}
function storageStatus(message,error=false){$("storage-status").textContent=message;$("storage-status").classList.toggle("error",error);}
function renderStores(){
  const current=$("storage-select").value;
  $("storage-select").innerHTML='<option value="">Choose a connection</option>'+stores.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.bucket)}</option>`).join("");
  $("storage-select").value=stores.some(p=>p.id===current)?current:(stores[0]?.id||"");
}
function changeStorageTab(name){
  for(const tab of ["browse","url"]){const active=tab===name;$("storage-"+tab).classList.toggle("hidden",!active);$("storage-"+tab+"-tab").classList.toggle("active",active);$("storage-"+tab+"-tab").setAttribute("aria-selected",String(active));}
}
function resetStorageListing(){
  storageRequest++;storageRows=[];storageNext=null;storageLoading=false;
  $("storage-more").classList.add("hidden");$("storage-list-button").disabled=false;
  $("storage-objects").innerHTML='<p class="small">Browse a folder to choose a CSV or TSV dataset.</p>';
}
function openStorage(split){
  if(!connected){notice("Connect this computer to browse your storage.",true);showConnection();return;}
  storageSplit=split;storageSession++;resetStorageListing();renderStores();changeStorageTab("browse");
  $("storage-dialog-title").textContent="Choose your "+(split==="train"?"training":"test")+" set.";
  $("dataset-url").value="";$("storage-prefix").value=stores.find(p=>p.id===$("storage-select").value)?.prefix||"";
  $("storage-settings").open=!stores.length;storageStatus("Storage credentials stay with your connector.");
  $("storage-dialog").showModal();
  if(stores.length)listStorage(false);
}
function renderStorageRows(){
  $("storage-objects").innerHTML=storageRows.length?storageRows.map((o,i)=>`<button type="button" class="storage-object" data-storage-object="${i}" ${o.supported?"":"disabled"}><span><strong>${esc(o.key)}</strong><small>${Number.isFinite(o.size)?(o.size/1024).toFixed(1)+" KB":""}${o.last_modified?" · "+esc(o.last_modified):""}</small></span><span>${o.supported?"Select ↗":o.size===0?"Empty file":o.size>24*1024**2?"Exceeds 24 MB":"Unavailable"}</span></button>`).join(""):'<p class="small">No files found in this folder.</p>';
  document.querySelectorAll("[data-storage-object]").forEach(b=>b.addEventListener("click",()=>importStorageObject(storageRows[Number(b.dataset.storageObject)])));
  $("storage-more").classList.toggle("hidden",!storageNext);
}
async function listStorage(more=false){
  const storeID=$("storage-select").value;
  if(!storeID){storageStatus("Add or select a storage connection first.",true);return;}
  if(storageLoading)return;
  const request=++storageRequest,session=storageSession,prefix=$("storage-prefix").value;
  storageLoading=true;$("storage-list-button").disabled=true;$("storage-more").disabled=true;
  storageStatus("Reading your storage…");
  try{
    const result=await api("/api/storage/objects",{store_id:storeID,prefix,...(more&&storageNext?{continuation_token:storageNext}:{})});
    if(request!==storageRequest||session!==storageSession)return;
    storageRows=more?[...storageRows,...result.objects]:result.objects;storageNext=result.next_token;renderStorageRows();
    storageStatus("Choose a dataset to import. Files are read directly by your connector.");
  }catch(error){if(request===storageRequest&&session===storageSession)storageStatus(error.message,true);}
  finally{if(request===storageRequest){storageLoading=false;$("storage-list-button").disabled=false;$("storage-more").disabled=false;}}
}
async function importDataset(body){
  const split=storageSplit,session=storageSession,revision=++datasetRevision[split];
  pendingFiles[split]=null;importingDatasets++;connectionUI(connected);
  storageStatus("Importing and checking your dataset…");
  document.querySelectorAll(".storage-object").forEach(b=>b.disabled=true);$("import-url").disabled=true;
  try{
    const data=await api("/api/datasets/import",body);
    if(session!==storageSession||revision!==datasetRevision[split])return;
    acceptDataset(split,data);$("dataset-url").value="";$("storage-dialog").close();clearNotice();
  }catch(error){if(session===storageSession)storageStatus(error.message,true);}
  finally{importingDatasets--;connectionUI(connected);if(session===storageSession){$("import-url").disabled=false;renderStorageRows();}}
}
function importStorageObject(object){return importDataset({store_id:$("storage-select").value,key:object.key,etag:object.etag,selection_id:object.selection_id});}
function storageCredentialsUI(){const env=$("store-auth").value==="env";document.querySelectorAll(".store-env").forEach(el=>el.classList.toggle("hidden",!env));document.querySelectorAll(".store-profile").forEach(el=>el.classList.toggle("hidden",env));}
async function finishConnection(value){
  token=value;sessionStorage.setItem("foldguard-service-token",token);await refresh();
  if(!connected)throw new Error("The connector did not accept this connection.");
  $("service-token").value=token;if($("connection-dialog").open)$("connection-dialog").close();clearNotice();await uploadPendingFiles();scheduleSummary();
}
async function startPairing(){
  if(localPage){try{const r=await fetch(base+"/api/bootstrap");if(!r.ok)throw new Error();await finishConnection((await r.json()).token);}catch(error){$("pair-status").textContent="Start your connector and try again.";}return;}
  pairingState=randomID();clearTimeout(pairingTimer);pairingWindow=window.open(base+"/connect?state="+encodeURIComponent(pairingState),"foldguard-connect-"+pairingState,"popup,width=600,height=680");
  $("pair-status").textContent=pairingWindow?"Allow this site in the local window. If it cannot open, start your connector and try again.":"Your browser blocked the local window. Allow popups for this site and try again.";
  pairingTimer=setTimeout(()=>{pairingState="";$("pair-status").textContent="The connection window expired. Start your connector and try again.";},180000);
}
window.addEventListener("message",async event=>{
  if(event.origin!==location.origin||event.source!==pairingWindow||!pairingState||event.data?.type!=="foldguard:paired"||event.data.state!==pairingState||typeof event.data.token!=="string")return;
  clearTimeout(pairingTimer);pairingState="";
  try{await finishConnection(event.data.token);pairingWindow?.close();pairingWindow=null;}catch(error){$("pair-status").textContent="Could not connect. Start the connector and try again.";notice(error.message,true);}
});
function receivePairingFragment(){
  const fragment=new URLSearchParams(location.hash.slice(1));if(!fragment.has("connect_token"))return false;
  const value=fragment.get("connect_token"),state=fragment.get("state");history.replaceState(null,"",location.pathname+location.search);
  if(!/^[a-f0-9]{32}$/.test(state||"")||!value||value.length>256)return false;
  token=value;sessionStorage.setItem("foldguard-service-token",token);
  if(window.opener){try{window.opener.postMessage({type:"foldguard:paired",state,token:value},location.origin);setTimeout(()=>window.close(),200);}catch(error){/* This tab can connect independently. */}}
  return true;
}
function selectedCompute(){return document.querySelector('input[name="compute"]:checked').value;}
function renderCompute(){
  document.querySelectorAll("[data-compute-status]").forEach(el=>{
    const p=profiles.find(p=>p.id===el.dataset.computeStatus),check=checks[el.dataset.computeStatus];
    el.textContent=check?.ok?"● Connection checked":p?.assets_configured?"Not checked":"Configure assets";
    el.classList.toggle("ready",!!check?.ok);
  });
}
function configure(identifier){
  if(!connected){notice("Connect the companion service to configure compute.",true);showConnection();return;}
  activeProfile=profiles.find(p=>p.id===identifier);
  if(!activeProfile)return;
  $("compute-dialog-title").textContent="Configure "+activeProfile.name;
  for(const field of ["id","name","host","python","work_dir","model_dir","device","cpus","partition","minutes","memory_gb","ssh_socket"]){$("profile-"+field).value=activeProfile[field]??"";}
  for(const key of ["python","model_dir"]){$("profile-"+key).required=!activeProfile.assets_configured;$("profile-"+key).placeholder=activeProfile.assets_configured?"Configured by operator; leave blank to keep":"Enter the operator-provided path";}
  $("profile-work_dir").required=!activeProfile.workspace_configured;$("profile-work_dir").placeholder=activeProfile.workspace_configured?"Configured by operator; leave blank to keep":"Enter a dedicated working directory";
  $("host-label").classList.toggle("hidden",activeProfile.kind==="local");
  document.querySelectorAll(".remote-field").forEach(e=>e.classList.toggle("hidden",activeProfile.kind==="local"));
  document.querySelectorAll(".slurm-field").forEach(e=>e.classList.toggle("hidden",activeProfile.kind!=="slurm"));
  $("profile-check").textContent="Your SSH agent or existing session handles authentication. No passwords are stored here.";
  $("profile-check").className="profile-check";
  $("compute-dialog").showModal();
}
function profileForm(){
  const result={...activeProfile};
  for(const field of ["name","host","python","work_dir","model_dir","device","cpus","partition","minutes","memory_gb","ssh_socket"]){result[field]=$("profile-"+field).value.trim();}
  result.gpus=result.device==="cuda"?1:0;
  return result;
}
function renderRuns(){
  $("run-count").textContent=runs.length;
  $("runs-list").innerHTML=runs.length?runs.map(r=>`<article class="run-card"><div><h2>${esc(r.name)}</h2><p>${esc(r.compute)} · ${r.summary.train_rows.toLocaleString()} train / ${r.summary.test_rows.toLocaleString()} test · ${new Date(r.created_at*1000).toLocaleString()}</p></div><div><span class="pill ${esc(r.status)}">${esc(r.status)}</span><button data-open-run="${r.id}">View run ↗</button></div></article>`).join(""):`<div class="empty-list">Your model runs will appear here once you launch one.</div>`;
  document.querySelectorAll("[data-open-run]").forEach(b=>b.addEventListener("click",async()=>{currentRun=b.dataset.openRun;previousView=null;selectedLoss="";changeView("builder");await refreshRun();window.scrollTo({top:0,behavior:"smooth"});}));
}
function plot(series,{xLabel="Training step",yLabel="Log loss",diagonal=false}={}){
  const W=350,H=180,L=40,R=12,T=12,B=30;
  const points=series.flatMap(s=>s.points).filter(p=>p.every(Number.isFinite));
  if(!points.length)return "";
  const xmax=Math.max(1,...points.map(p=>p[0])),ymax=Math.max(.01,...points.map(p=>p[1]))*1.07;
  const x=v=>L+(W-L-R)*v/xmax,y=v=>H-B-(H-T-B)*v/ymax;
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)} versus ${esc(xLabel)}">`;
  for(let i=0;i<=3;i++){const value=ymax*i/3;svg+=`<path d="M${L} ${y(value)}H${W-R}" stroke="#c6c2b8" fill="none"/><text class="plot-label" x="${L-7}" y="${y(value)+3}" text-anchor="end">${value.toFixed(2)}</text>`;}
  for(let i=0;i<=4;i++){const value=xmax*i/4;svg+=`<text class="plot-label" x="${x(value)}" y="${H-B+15}" text-anchor="middle">${Number.isInteger(xmax)?Math.round(value):value.toFixed(1)}</text>`;}
  if(diagonal)svg+=`<path d="M${x(0)} ${y(0)}L${x(1)} ${y(1)}" stroke="#c6d1bd" stroke-dasharray="4 4" fill="none"/>`;
  for(const s of series){svg+=`<path d="${s.points.filter(p=>p.every(Number.isFinite)).map((p,i)=>(i?"L":"M")+x(p[0]).toFixed(2)+" "+y(p[1]).toFixed(2)).join(" ")}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;}
  svg+=`<text class="plot-label" x="${(W+L-R)/2}" y="${H-1}" text-anchor="middle">${esc(xLabel)}</text></svg>`;
  return svg;
}
function renderLoss(events){
  const losses=events.filter(e=>e.event==="loss");
  if(!losses.length)return;
  const keys=[...new Set(losses.map(e=>e.series))];

  $("loss-series").innerHTML=keys.map(key=>`<option value="${esc(key)}">${esc(key)}</option>`).join("");
  const chosen=selectedLoss&&keys.includes(selectedLoss)?selectedLoss:keys.at(-1);
  $("loss-series").value=chosen;
  const data=losses.filter(e=>e.series===chosen);
  const series=[{color:"#3f7a3a",points:data.map(e=>[e.step,e.train_loss])}];
  const val=data.filter(e=>e.validation_loss!==null);
  if(val.length)series.push({color:"#6f5fa5",points:val.map(e=>[e.step,e.validation_loss])});
  $("loss-chart").className="";$("loss-chart").innerHTML=plot(series);
}
function renderMetrics(view){
  const r=view.result;
  $("metrics-empty").classList.toggle("hidden",!!r);$("metrics-content").classList.toggle("hidden",!r);
  if(!r)return;
  if(renderedResultRun===view.id)return;
  renderedResultRun=view.id;
  const m=r.metrics,d=r.dataset,classes=d.classes;
  $("metrics-content").innerHTML=`<div class="metric-grid"><div><small>AUROC${classes.length>2?" · macro OVR":""}</small><strong>${m.auroc.toFixed(4)}</strong></div><div><small>Balanced accuracy</small><strong>${(m.balanced_accuracy*100).toFixed(1)}<span class="small">%</span></strong></div><div><small>Macro F1</small><strong>${m.macro_f1.toFixed(3)}</strong></div><div><small>Average precision</small><strong>${m.average_precision.toFixed(3)}</strong></div></div><div class="metric-note">${d.test_rows.toLocaleString()} held-out proteins · ${esc(m.auroc_definition)}<br>${d.group_disjoint?"✓ Supplied family/groups are disjoint":"Family-disjoint evaluation not established"}<br>${r.training_limit_reached?"Training reached its configured limit":"Training complete"}</div><div class="curve-controls"><label>ROC curve<select id="roc-class">${classes.map((c,i)=>`<option value="${esc(c)}"${i===(classes.length===2?1:0)?" selected":""}>${esc(c)}</option>`).join("")}</select></label></div><div id="roc-chart"></div><details class="result-details"><summary>Confusion matrix &amp; class metrics</summary><div class="table-wrap"><table><thead><tr><th>Actual ↓ / predicted →</th>${classes.map(c=>`<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${m.confusion_matrix.map((row,i)=>`<tr><th>${esc(classes[i])}</th>${row.map(n=>`<td>${n}</td>`).join("")}</tr>`).join("")}</tbody></table></div><div class="table-wrap"><table><thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>F1</th><th>n</th></tr></thead><tbody>${m.per_class.map(c=>`<tr><td>${esc(c.label)}</td><td>${c.precision.toFixed(3)}</td><td>${c.recall.toFixed(3)}</td><td>${c.f1.toFixed(3)}</td><td>${c.support}</td></tr>`).join("")}</tbody></table></div><p class="table-caption">Predictions use the largest class logit. Scores are not independently calibrated.</p></details><div class="result-warning">${r.limitations.map(esc).join("<br>")}</div><button class="primary" id="download-model">Download evaluation report ↓</button>`;
  const roc=()=>{$("roc-chart").innerHTML=plot([{color:"#6f5fa5",points:m.curves[$("roc-class").value].roc}],{xLabel:"False positive rate",yLabel:"True positive rate",diagonal:true});};
  $("roc-class").addEventListener("change",roc);roc();
  $("download-model").addEventListener("click",async()=>{
    try{const blob=await api("/api/artifact/"+view.id,undefined,{blob:true});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="evaluation-"+view.id.slice(0,8)+".zip";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}catch(error){notice(error.message,true);}
  });
}
function renderMonitor(view){
  const s=view.status,completed=s.status==="completed";
  $("monitor-name").textContent=view.name;
  $("monitor-message").textContent=s.message||s.stage;
  $("run-badge").textContent=s.status;$("run-badge").className="pill "+s.status;
  $("stop-run").classList.toggle("hidden",["completed","failed","cancelled"].includes(s.status));
  const stages=["validating","starting","preparing","training","testing","completed"],index=stages.indexOf(s.stage);
  [...$("pipeline-steps").children].forEach((el,i)=>{const current=i===0?index>=0&&index<=2:i===1?index===3:index>=4;const done=i===0?index>2:i===1?index>3:completed;el.classList.toggle("active",current);el.classList.toggle("done",done);});
  let percent=completed?100:s.stage==="preparing"?5+55*(s.completed||0)/(s.total||1):s.stage==="training"?75:s.stage==="testing"?95:2;
  $("progress-track").classList.remove("hidden");$("progress-fill").style.width=percent+"%";
  $("progress-caption").textContent=view.compute+(view.dispatch.job_id?" · Job "+view.dispatch.job_id:"")+(s.stage==="preparing"?" · "+(s.completed||0)+" / "+s.total+" proteins":"");
  if(view.connection_error)$("progress-caption").textContent+=" · Connection interrupted: "+view.connection_error.message;
  const losses=view.events.filter(e=>e.event==="loss");
  if(!losses.length){$("loss-series").innerHTML='<option value="">Waiting for training</option>';$("loss-chart").className="chart-placeholder";$("loss-chart").innerHTML='<span class="chart-ghost">╱╲__</span><p>Live loss, once training starts.</p>';}
  else renderLoss(view.events);
  renderMetrics(view);previousView=view;
}
async function refreshRun(){if(!currentRun||!connected)return;const view=await api("/api/runs/"+currentRun);renderMonitor(view);}
async function refresh(){
  if(polling||!token)return;polling=true;
  try{const data=await api("/api/state",undefined,{timeout:15000});profiles=data.profiles;runs=data.runs;checks=data.checks;stores=data.stores||[];connectionUI(true);renderCompute();renderRuns();await refreshRun();}
  catch(error){connectionUI(false);if(currentRun)$("progress-caption").textContent="Companion unavailable. Reconnect to refresh this run.";}
  finally{polling=false;}
}

document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>changeView(b.dataset.view)));
for(const split of ["train","test"]){
  $(split+"-file").addEventListener("change",e=>loadFile(split,e.target.files[0]));
  const drop=$(split+"-drop");
  for(const event of ["dragenter","dragover"])drop.addEventListener(event,e=>{e.preventDefault();drop.classList.add("dragover");});
  for(const event of ["dragleave","drop"])drop.addEventListener(event,e=>{e.preventDefault();drop.classList.remove("dragover");});
  drop.addEventListener("drop",e=>loadFile(split,e.dataTransfer.files[0]));
}
for(const id of ["sequence-column","label-column","id-column","group-column"])$(id).addEventListener("change",scheduleSummary);
document.querySelectorAll('input[name="compute"]').forEach(input=>input.addEventListener("change",()=>{document.querySelectorAll(".compute-card").forEach(c=>c.classList.toggle("selected",c.querySelector("input").checked));}));
for(const id of ["connection-button","open-connection"])$(id).addEventListener("click",showConnection);
$("pair-service").addEventListener("click",startPairing);
document.querySelectorAll("[data-storage-split]").forEach(b=>b.addEventListener("click",()=>openStorage(b.dataset.storageSplit)));
$("storage-browse-tab").addEventListener("click",()=>changeStorageTab("browse"));
$("storage-url-tab").addEventListener("click",()=>changeStorageTab("url"));
$("storage-dialog").addEventListener("close",()=>{storageSession++;resetStorageListing();$("import-url").disabled=false;$("dataset-url").value="";});
$("add-storage").addEventListener("click",()=>{$("storage-settings").open=true;$("store-name").focus();});
$("storage-select").addEventListener("change",()=>{resetStorageListing();$("storage-prefix").value=stores.find(p=>p.id===$("storage-select").value)?.prefix||"";if($("storage-select").value)listStorage();});
$("storage-prefix").addEventListener("input",resetStorageListing);
$("storage-list-form").addEventListener("submit",e=>{e.preventDefault();listStorage(false);});
$("storage-more").addEventListener("click",()=>listStorage(true));
$("store-auth").addEventListener("change",storageCredentialsUI);
$("store-provider").addEventListener("change",()=>{const r2=$("store-provider").value==="r2";$("store-region").value=r2?"auto":"us-east-1";$("store-access_key_env").value=r2?"R2_ACCESS_KEY_ID":"AWS_ACCESS_KEY_ID";$("store-secret_key_env").value=r2?"R2_SECRET_ACCESS_KEY":"AWS_SECRET_ACCESS_KEY";});
$("storage-form").addEventListener("submit",async e=>{
  e.preventDefault();const button=$("save-storage");button.disabled=true;
  const body={id:"store-"+randomID(),name:$("store-name").value.trim(),provider:$("store-provider").value};
  for(const field of ["endpoint_url","bucket","prefix","region"])body[field]=$("store-"+field).value.trim();
  if($("store-auth").value==="profile")body.aws_profile=$("store-aws_profile").value.trim()||"default";
  else for(const field of ["access_key_env","secret_key_env","session_token_env"])body[field]=$("store-"+field).value.trim();
  try{const result=await api("/api/storage/profile",body);stores=[...stores.filter(p=>p.id!==result.profile.id),result.profile];renderStores();$("storage-select").value=result.profile.id;$("storage-prefix").value=result.profile.prefix||"";$("storage-settings").open=false;resetStorageListing();await listStorage();}
  catch(error){storageStatus(error.message,true);}finally{button.disabled=false;}
});
$("storage-url-form").addEventListener("submit",e=>{e.preventDefault();const value=$("dataset-url").value.trim();try{if(new URL(value).protocol!=="https:")throw new Error();importDataset({url:value});}catch(error){storageStatus("Enter a direct HTTPS download link.",true);}});
$("configure-compute").addEventListener("click",()=>configure(selectedCompute()));
$("copy-token").addEventListener("click",async()=>{try{await navigator.clipboard.writeText(token);$("copy-token").textContent="Copied ✓";}catch(error){$("service-token").type="text";$("service-token").select();}});
$("connect-service").addEventListener("click",async()=>{
  const button=$("connect-service");button.disabled=true;
  try{token=$("service-token").value.trim();await api("/api/state",undefined,{timeout:15000});sessionStorage.setItem("foldguard-service-token",token);connectionUI(true);$("connection-dialog").close();clearNotice();await refresh();await uploadPendingFiles();}
  catch(error){notice("Could not connect. Start the companion service, check the token, and allow local-network access if your browser requests it. "+error.message,true);}
  finally{button.disabled=false;}
});
$("test-compute").addEventListener("click",async()=>{
  const button=$("test-compute");button.disabled=true;$("profile-check").className="profile-check";$("profile-check").textContent="Checking compute connection and model assets…";
  try{const result=await api("/api/check",profileForm());checks[activeProfile.id]=result;$("profile-check").textContent=(result.ok?"✓ ":"")+result.message+(result.host?" · "+result.host:"");$("profile-check").classList.toggle("error",!result.ok);renderCompute();}
  catch(error){$("profile-check").textContent=error.message;$("profile-check").classList.add("error");}
  finally{button.disabled=false;}
});
$("compute-form").addEventListener("submit",async e=>{
  e.preventDefault();try{await api("/api/profile",profileForm());$("compute-dialog").close();await refresh();notice("Compute profile saved. Test its connection before launching.");}catch(error){$("profile-check").textContent=error.message;$("profile-check").classList.add("error");}
});
$("launch-run").addEventListener("click",async()=>{
  if(!connected){showConnection();return;}if(importingDatasets||pendingFiles.train||pendingFiles.test){notice("Wait for dataset imports to finish.",true);return;}if(!files.train?.id||!files.test?.id){notice("Choose a training set and a test set first.",true);return;}
  busy=true;connectionUI(true);$("launch-run").textContent="Checking & launching…";clearNotice();
  try{const response=await api("/api/runs",{...datasetPayload(),
    annotation:mapping().label,name:$("run-name").value.trim()||(mapping().label+" · v1"),compute:selectedCompute()});
    currentRun=response.id;previousView=null;selectedLoss="";await refresh();notice("Run launched. You can follow its progress here or return to it from Model runs.");}
  catch(error){notice(error.message,true);}finally{busy=false;$("launch-run").innerHTML='Build &amp; evaluate <span>↗</span>';connectionUI(connected);}
});
$("loss-series").addEventListener("change",()=>{selectedLoss=$("loss-series").value;if(previousView)renderLoss(previousView.events);});
$("stop-run").addEventListener("click",async()=>{if(!currentRun)return;try{const result=await api("/api/runs/"+currentRun+"/cancel",{});notice(result.message||"Stop requested.");}catch(error){notice(error.message,true);}});

async function initialize(){
  receivePairingFragment();connectionUI(false);renderCompute();renderRuns();
  if(localPage){
    try{const r=await fetch(base+"/api/bootstrap");const data=await r.json();token=data.token;sessionStorage.setItem("foldguard-service-token",token);}
    catch(error){notice("Start the companion service to use this interface.",true);}
  }
  await refresh();
  if(!connected&&!localPage)notice("Connect the local companion service to configure compute and build models. Get the private connector installer from your Foldguard operator, then connect this computer.");
  setInterval(()=>{if(!document.hidden)refresh();},4000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)refresh();});
}
initialize();
