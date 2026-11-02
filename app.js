"use strict";
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const localPage = ["localhost","127.0.0.1"].includes(location.hostname);
const base = localPage ? location.origin : "http://127.0.0.1:8773";
let token = sessionStorage.getItem("foldguard-service-token") || "";
let connected = false, profiles = [], runs = [], checks = {}, stores = [], currentRun = null, activeProfile = null;
let supportedTaskTypes = ["classification"], storageAuthMethods = [];
let backgroundDatasetImports = false, maxImportBytes = 24*1024**2, datasetFormats = ["csv","tsv"];
let annotationDialogState = null, selectedComputeID = "", readyValidationID = "", terminalCommandRevision = 0;
let polling = false, busy = false, selectedLoss = "", previousView = null;
const selectedLossMetric = {classification:"loss",regression:"loss"};
const files = {train:null,test:null};
let summaryTimer, renderedResultRun = null, validationRevision = 0;
const datasetRevision = {train:0,test:0}, pendingFiles = {train:null,test:null};
const datasetCatalog = new Map(), datasetChoices = {train:"",test:""}, datasetImports = {train:null,test:null};
let datasetCatalogEpoch = 0, datasetConnectionEpoch = 0;
let storageSplit = "train", storageSession = 0, storageRequest = 0, storageNext = null, storageRows = [], storageLoading = false, storageConnecting = false;
let reconnectingStorageID = null;
let pairingWindow = null, pairingState = "", pairingTimer = null, importingDatasets = 0;
const randomID = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,"0")).join("");
const validConnectionToken = value => typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);

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
  if(!response.ok)throw new Error(data.error || "Request failed");
  return data;
}
function connectionUI(value) {
  if(connected&&!value){datasetCatalogEpoch++;datasetConnectionEpoch++;datasetCatalog.clear();}
  connected=value;
  $("connection-dot").classList.toggle("online",value);
  $("side-dot").classList.toggle("online",value);
  $("connection-label").textContent=value?"Connected":"Connect this computer";
  $("side-status").textContent=value?"Connected":"Disconnected";
  $("launch-run").disabled=!value||busy||importingDatasets>0||!!pendingFiles.train||!!pendingFiles.test||files.train?.kind==="fasta"||files.test?.kind==="fasta"||!selectedCompute()||!readyValidationID;
  $("local-token-tools").classList.toggle("hidden",!localPage||!value);
  renderDatasetChoices();
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
  let fields = (files.train?.kind!=="fasta"&&files.train?.columns) || (files.test?.kind!=="fasta"&&files.test?.columns) || [];
  if(files.train?.kind!=="fasta"&&files.test?.kind!=="fasta"&&files.train?.columns&&files.test?.columns)fields=fields.filter(f=>files.test.columns.includes(f));
  const definitions=[
    ["sequence-column","",/^(sequence|protein_sequence|seq)$/i],
    ["label-column","",/^(label|annotation|class|target|value|origin|location|role|function_class)$/i],
    ["id-column","Generate IDs",/^(id|protein_id|accession)$/i],
    ["group-column","No group column",/^(family|family_taxid|group|component_id|cluster|cluster_id)$/i]];
  for(const [id,empty,pattern] of definitions){
    const select=$(id),current=select.value;
    const preferred=id==="label-column"&&(files.train?.curation||files.test?.curation)?fields.find(f=>/^function_class$/i.test(f)):"";
    select.innerHTML=(empty?`<option value="">${empty}</option>`:`<option value="">Choose a column</option>`)+fields.map(f=>`<option value="${esc(f)}">${esc(f)}</option>`).join("");
    select.value=fields.includes(current)?current:(preferred||fields.find(f=>pattern.test(f))||"");
  }
  const group=files.train?.curation?.group_column||files.test?.curation?.group_column;
  if(group&&fields.includes(group))$("group-column").value=group;
  if(!$("run-name").value&&$("label-column").value)$("run-name").placeholder=$("label-column").value+" · v1";
  scheduleSummary();
}
function datasetChanged() {
  validationRevision++;readyValidationID="";
  clearTimeout(summaryTimer);
  $("dataset-summary").classList.add("hidden");
  populateColumns();
}
function acceptDataset(split, data, choice="") {
  files[split]=data;
  datasetChoices[split]=choice;
  $(split+"-filename").textContent=data.name;
  $(split+"-detail").textContent=datasetDetail(data);
  $(split+"-drop").classList.add("filled");
  renderDatasetChoices();
  datasetChanged();
}
async function uploadPendingFiles(){}
function mapping(){return {sequence:$("sequence-column").value,label:$("label-column").value,id:$("id-column").value,group:$("group-column").value};}
function taskType(){return $("task-type").value;}
function supportsTask(){return taskType()!=="regression"||supportedTaskTypes.includes("regression");}
function runTaskType(view){return view?.result?.task_type||view?.result?.dataset?.task_type||view?.summary?.task_type||view?.task_type||"classification";}
function numberText(value,digits=3){
  if(!Number.isFinite(value))return "Undefined";
  if(value===0)return "0";
  return Math.abs(value)>=10000||Math.abs(value)<.001?value.toExponential(2):value.toLocaleString(undefined,{maximumFractionDigits:digits});
}
function taskTypeHelp(){
  const continuous=taskType()==="regression";
  $("annotation-type-badge").textContent=continuous?"Continuous value":"Discrete categories";
  $("dataset-template").href=continuous?"./regression-train-template.csv":"./train-template.csv";
  $("annotation-type-help").textContent=continuous&&connected&&!supportsTask()?"Connector update required for regression":"";
}
function updateTaskType(){
  taskTypeHelp();
  validationRevision++;readyValidationID="";connectionUI(connected);clearTimeout(summaryTimer);$("dataset-summary").classList.add("hidden");scheduleSummary();
}
function datasetPayload(){return {train_ref:files.train.id,test_ref:files.test.id,mapping:mapping(),task_type:taskType(),compute:selectedCompute()};}
function scheduleSummary(){validationRevision++;readyValidationID="";connectionUI(connected);clearTimeout(summaryTimer);summaryTimer=setTimeout(validateSummary,300);}
function separationSummary(data){
  const lines=[];
  if(data.exact_sequence_disjoint===true)lines.push("✓ Protein overlap: none");
  else if(data.exact_sequence_disjoint===false)lines.push('<span class="warning-text">Protein overlap: present</span>');
  if(data.group_disjoint===true)lines.push("✓ Group overlap: none");
  else if(data.group_disjoint===false)lines.push(`<span class="warning-text">${data.group_column?"Group overlap: present":"Group separation: unknown"}</span>`);
  return lines.join("<br>");
}
function evaluationWarnings(data,extra=[]){
  const messages=[...(Array.isArray(data.warnings)?data.warnings:[]),...(Array.isArray(extra)?extra:[])];
  if(data.exact_sequence_disjoint===false)messages.push("Protein overlap: scores may be optimistic");
  if(data.group_disjoint===false&&data.group_column)messages.push("Unseen-group performance: unverified");
  if(data.homology_screened!==true)messages.push("Homology screening: none");
  return [...new Set(messages.filter(message=>typeof message==="string"&&message))].map(esc).join("<br>");
}
async function validateSummary(){
  if(!connected||!selectedCompute()||!backgroundDatasetImports||!files.train?.id||!files.test?.id||files.train.kind==="fasta"||files.test.kind==="fasta"||!mapping().sequence||!mapping().label)return;
  if(!supportsTask()){$("dataset-summary").innerHTML='<div class="warning-text">Connector update required for regression</div>';$("dataset-summary").classList.remove("hidden");return;}
  const revision=validationRevision;
  try{
    $("dataset-summary").textContent="Checking datasets…";$("dataset-summary").classList.remove("hidden");
    const queued=await api("/api/validations",datasetPayload());
    if(!/^[a-f0-9]{32}$/.test(queued.id||""))throw new Error("Invalid dataset check reference");
    let job=queued;
    while(connected&&revision===validationRevision&&["queued","running"].includes(job.status)){
      await new Promise(resolve=>setTimeout(resolve,1500));
      if(!connected||revision!==validationRevision)return;
      job=await api("/api/validations/"+queued.id);
      if(revision!==validationRevision)return;
      $("dataset-summary").textContent=job.message||"Checking datasets…";
    }
    if(!connected||revision!==validationRevision)return;
    if(job.status!=="completed"||!job.summary)throw new Error(job.message||"Dataset check failed");
    const data=job.summary;
    const continuous=data.task_type==="regression";
    const extra=continuous?`<span><strong>${esc(numberText(data.target_summary.train.min))}–${esc(numberText(data.target_summary.train.max))}</strong>training value range</span>`:`<span><strong>${data.classes.length}</strong>classes</span>`;
    const target=continuous?`<div class="target-summary">Test value range: ${esc(numberText(data.target_summary.test.min))} to ${esc(numberText(data.target_summary.test.max))}<br>Training mean: ${esc(numberText(data.target_summary.train.mean))} · Standard deviation: ${esc(numberText(data.target_summary.train.std))}</div>`:"";
    const countLines=[];
    for(const [counts,label] of [[data.source_rows,"Source rows"],[data.excluded_unlabeled,"Unlabeled rows excluded"]]){
      if(Number.isSafeInteger(counts?.train)&&counts.train>=0&&Number.isSafeInteger(counts?.test)&&counts.test>=0)countLines.push(`${label}: ${counts.train.toLocaleString()} training · ${counts.test.toLocaleString()} test`);
    }
    const duplicates=data.excluded_duplicates;
    if(Number.isSafeInteger(duplicates?.train)&&duplicates.train>=0&&Number.isSafeInteger(duplicates?.test)&&duplicates.test>=0&&(duplicates.train||duplicates.test))countLines.push(`Duplicate rows consolidated: ${duplicates.train.toLocaleString()} training · ${duplicates.test.toLocaleString()} test`);
    const inputCounts=countLines.length?`<div class="target-summary">${countLines.join("<br>")}</div>`:"";
    $("dataset-summary").innerHTML=`<div class="summary-grid${continuous?" numeric-summary":""}"><span><strong>${data.train_rows.toLocaleString()}</strong>training proteins</span><span><strong>${data.test_rows.toLocaleString()}</strong>test proteins</span>${extra}</div>${inputCounts}${target}<div>${separationSummary(data)}</div><div class="warning-text">${evaluationWarnings(data)}</div>`;
    $("dataset-summary").classList.remove("hidden");readyValidationID=queued.id;connectionUI(connected);
  }catch(error){if(revision===validationRevision){$("dataset-summary").innerHTML=`<div class="warning-text">${esc(error.message)}</div>`;$("dataset-summary").classList.remove("hidden");}}
}
function storageStatus(message,error=false){$("storage-status").textContent=message;$("storage-status").classList.toggle("error",error);}
function datasetDetail(data){
  const destination=data.compute_name?" · On "+data.compute_name:"";
  if(data.kind==="fasta")return data.rows.toLocaleString()+" sequences · Annotations required"+destination;
  const detail=[data.rows.toLocaleString()+" rows · "+data.columns.length+" columns"];
  if(data.curation)detail.push(""+data.curation.protocol.replace("cluster","")+"% cluster holdout");
  if(data.input_table_format==="mmseqs_cluster")detail.push("Cluster membership");
  if(data.unmatched_metadata_rows)detail.push(data.unmatched_metadata_rows.toLocaleString()+" metadata rows not used");
  for(const [key,label] of [["matched_rows","matched proteins"],["unmatched_annotation_rows","annotation rows not used"],["unannotated_sequence_rows","sequences without annotations"]])if(Number.isInteger(data[key])&&data[key]>=0)detail.push(data[key].toLocaleString()+" "+label);
  return detail.join(" · ")+destination;
}
function datasetObjectFormat(key){return backgroundDatasetImports?/\.(csv|tsv|fa|faa|fasta)(\.gz)?$/i.test(key):/\.(csv|tsv)$/i.test(key);}
function annotationTableRows(){return datasetCatalogObjects().filter(row=>/\.(csv|tsv)(\.gz)?$/i.test(row.object.key)||(!annotationDialogState?.sequence?.columns?.includes("sequence")&&datasetObjectFormat(row.object.key)));}
function datasetCatalogSignature(store){return JSON.stringify([store.id,store.bucket,store.prefix,store.configured]);}
function datasetChoiceValue(storeID,object){return JSON.stringify([storeID,object.key,object.selection_id]);}
function datasetCatalogObjects(){
  return stores.flatMap(store=>{
    const entry=datasetCatalog.get(store.id);
    return entry?.signature===datasetCatalogSignature(store)?entry.objects.filter(o=>o.supported&&datasetObjectFormat(o.key)&&o.etag&&o.selection_id).map(object=>({store,object,value:datasetChoiceValue(store.id,object)})):[];
  });
}
function renderDatasetChoices(){
  const available=datasetCatalogObjects(),entries=[...datasetCatalog.values()],loading=entries.some(e=>e.loading),hasMore=entries.some(e=>e.next),errors=entries.filter(e=>e.error);
  const protocol=$("cluster-holdout").value||"cluster90";
  $("cluster-holdout-control").classList.toggle("hidden",!stores.some(s=>s.curated));
  $("cluster-holdout").disabled=!connected||importingDatasets>0;
  for(const split of ["train","test"]){
    const select=$(split+"-dataset-select"),choice=datasetImports[split]?.choice||datasetChoices[split],snapshot=files[split];
    let html='<option value="" disabled>Choose a '+(split==="train"?"training":"test")+' dataset</option>';
    if(snapshot&&!available.some(row=>row.value===choice))html+=`<option value="${esc(choice||"imported-snapshot")}" disabled>${esc(snapshot.name)} · imported snapshot</option>`;
    for(const store of stores){
      const rows=available.filter(row=>row.store.id===store.id&&(!row.object.split||row.object.split===split)&&(!row.object.protocol||row.object.protocol===protocol));
      if(rows.length)html+=`<optgroup label="${esc(store.name)}">${rows.map(row=>`<option value="${esc(row.value)}">${esc(row.object.label||row.object.key)}</option>`).join("")}</optgroup>`;
    }
    if(select.datasetOptionsHTML!==html){select.innerHTML=html;select.datasetOptionsHTML=html;}
    select.value=choice||(snapshot?"imported-snapshot":"");
    select.disabled=!connected||!available.length||!!datasetImports[split]||!!pendingFiles[split];
    select.setAttribute("aria-busy",String(!!datasetImports[split]));
    $(split+"-import-cancel").classList.toggle("hidden",!datasetImports[split]?.background);
    $(split+"-import-cancel").disabled=!!datasetImports[split]?.cancelRequested||!connected;
    $(split+"-attach-annotations").classList.toggle("hidden",!snapshot||!!snapshot.curation);
    $(split+"-attach-annotations").disabled=!connected||!backgroundDatasetImports||!!datasetImports[split];
  }
  const formats=backgroundDatasetImports?"CSV/TSV/FASTA":"CSV/TSV";
  let message;
  if(!connected)message="Connector disconnected";
  else if(!stores.length)message="Storage disconnected";
  else if(loading)message="Reading storage…"+(available.length?" · "+available.length.toLocaleString()+" files":"");
  else if(available.length&&available.every(row=>row.object.virtual))message="Annotated viral proteins";
  else if(available.length)message=available.length.toLocaleString()+" "+formats+" file"+(available.length===1?"":"s");
  else if(hasMore)message="No "+formats+" files · More available";
  else message="No "+formats+" files";
  const unconfigured=stores.some(store=>store.configured===false);
  if(connected&&unconfigured&&!available.length)message+=" · Storage credentials required";
  if(connected&&errors.length)message+=" · Storage connection error";
  if(connected&&hasMore&&available.length&&!loading)message+=" · More files available";
  $("dataset-catalog-status").textContent=message;
  $("dataset-catalog-status").classList.toggle("error",connected&&errors.length>0);
  $("refresh-datasets").disabled=!connected||loading||!stores.some(store=>store.configured);
  $("more-datasets").classList.toggle("hidden",!connected||!hasMore);
  $("more-datasets").disabled=loading;
  if(annotationDialogState)renderAnnotationControls();
}
function changeClustering(){
  if(importingDatasets)return;
  for(const split of ["train","test"]){
    files[split]=null;datasetChoices[split]="";datasetRevision[split]++;
    $(split+"-filename").textContent="";
    $(split+"-detail").textContent=split==="train"?"":"";
    $(split+"-drop").classList.remove("filled");
  }
  datasetChanged();renderDatasetChoices();
}
function seedDatasetCatalog(store,result){
  if(!store?.configured)return;
  datasetCatalog.set(store.id,{signature:datasetCatalogSignature(store),objects:result.objects||[],next:result.next_token||null,loading:false,queued:false,error:"",request:0,pages:1,scanned:!result.next_token});
  renderDatasetChoices();
}
async function loadDatasetChoices(store,more=false){
  const entry=datasetCatalog.get(store.id);
  if(!connected||!store.configured||!entry||entry.loading||(more&&!entry.next))return;
  const epoch=datasetCatalogEpoch,request=++entry.request,continuation=more?entry.next:null;
  entry.loading=true;entry.error="";renderDatasetChoices();
  try{
    const result=await api("/api/storage/objects",{store_id:store.id,prefix:store.prefix||"",max_keys:1000,...(continuation?{continuation_token:continuation}:{})});
    if(!connected||epoch!==datasetCatalogEpoch||datasetCatalog.get(store.id)!==entry||entry.request!==request)return;
    const objects=more?[...entry.objects,...result.objects]:result.objects;
    entry.objects=[...new Map(objects.map(object=>[object.key,object])).values()];
    entry.next=result.next_token||null;entry.pages=more?entry.pages+1:1;
  }catch(error){if(epoch===datasetCatalogEpoch&&datasetCatalog.get(store.id)===entry&&entry.request===request)entry.error=error.message;}
  finally{if(epoch===datasetCatalogEpoch&&datasetCatalog.get(store.id)===entry&&entry.request===request){entry.loading=false;renderDatasetChoices();}}
}
async function syncDatasetCatalog(refresh=false,more=false){
  if(!connected){renderDatasetChoices();return;}
  if(refresh){datasetCatalogEpoch++;datasetCatalog.clear();}
  const ids=new Set(stores.filter(store=>store.configured).map(store=>store.id));
  for(const id of datasetCatalog.keys())if(!ids.has(id))datasetCatalog.delete(id);
  const pending=[];
  for(const store of stores.filter(store=>store.configured)){
    let entry=datasetCatalog.get(store.id);
    if(!entry||entry.signature!==datasetCatalogSignature(store)){
      entry={signature:datasetCatalogSignature(store),objects:[],next:null,loading:false,queued:true,error:"",request:0,pages:0,scanned:false};datasetCatalog.set(store.id,entry);pending.push([store,false]);
    }else if(more&&entry.next&&!entry.loading&&!entry.queued){entry.queued=true;pending.push([store,true]);}
    else if(!entry.scanned&&!entry.loading&&!entry.queued){entry.queued=true;pending.push([store,!!entry.next]);}
  }
  renderDatasetChoices();
  // Initial discovery reads metadata only, up to 20 pages per connection.
  // Larger stores remain browsable with a bounded one-page Load more action.
  const epoch=datasetCatalogEpoch;
  async function worker(){
    while(pending.length&&epoch===datasetCatalogEpoch){
      const [store,next]=pending.shift(),entry=datasetCatalog.get(store.id);
      if(!entry||entry.loading)continue;
      entry.queued=false;
      await loadDatasetChoices(store,next);
      while(!more&&epoch===datasetCatalogEpoch&&datasetCatalog.get(store.id)===entry&&entry.next&&!entry.error&&entry.pages<20)await loadDatasetChoices(store,true);
      if(epoch===datasetCatalogEpoch&&datasetCatalog.get(store.id)===entry)entry.scanned=true;
    }
  }
  await Promise.all(Array.from({length:Math.min(3,pending.length)},worker));
}
async function chooseDataset(split){
  const value=$(split+"-dataset-select").value,row=datasetCatalogObjects().find(candidate=>candidate.value===value);
  if(!connected||!row||datasetImports[split]){renderDatasetChoices();return;}
  if(files[split]&&datasetChoices[split]===value)return;
  return importDataset({store_id:row.store.id,key:row.object.key,etag:row.object.etag,selection_id:row.object.selection_id},{split,source:"dropdown",choice:value});
}
function renderStores(){
  const current=$("storage-select").value;
  $("storage-select").innerHTML='<option value="">Choose a connection</option>'+stores.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.bucket)}</option>`).join("");
  $("storage-select").value=stores.some(p=>p.id===current)?current:(stores[0]?.id||"");
  $("storage-browser-controls").classList.toggle("hidden",!stores.length);
}
function resetStorageListing(){
  storageRequest++;storageRows=[];storageNext=null;storageLoading=false;
  $("storage-more").classList.add("hidden");$("storage-list-button").disabled=false;
  $("storage-objects").innerHTML='<p class="small">Select folder</p>';
}
function openStorage(split){
  if(!connected){notice("Connector disconnected",true);showConnection();return;}
  reconnectingStorageID=null;
  storageSplit=split;storageSession++;resetStorageListing();renderStores();
  $("storage-dialog-title").textContent=(split==="train"?"Training":"Test")+" set";
  const selectedStore=stores.find(p=>p.id===$("storage-select").value),needsCredentials=selectedStore?.configured===false;
  $("storage-prefix").value=selectedStore?.prefix||"";
  clearStorageCredentials();storageCredentialsUI();
  $("storage-settings").open=!stores.length||needsCredentials;
  if(needsCredentials)prefillStorageReconnect(selectedStore);
  storageStatus(needsCredentials?"Storage credentials required":"");
  $("storage-dialog").showModal();
  if(stores.length&&!needsCredentials)listStorage(false);
}
function renderStorageRows(){
  $("storage-objects").innerHTML=storageRows.length?storageRows.map((o,i)=>(o.split&&o.split!==storageSplit)||(o.protocol&&o.protocol!==($("cluster-holdout").value||"cluster90"))?"":`<button type="button" class="storage-object" data-storage-object="${i}" ${o.supported?"":"disabled"}><span><strong>${esc(o.label||o.key)}</strong><small>${o.virtual?"Sequences + metadata":Number.isFinite(o.size)?formatImportBytes(o.size):""}${o.last_modified?" · "+esc(o.last_modified):""}</small></span><span>${o.supported?"Select ↗":o.size===0?"Empty file":o.size>maxImportBytes?"Exceeds "+formatImportBytes(maxImportBytes):"Unavailable"}</span></button>`).join(""):'<p class="small">No files</p>';
  document.querySelectorAll("[data-storage-object]").forEach(b=>b.addEventListener("click",()=>importStorageObject(storageRows[Number(b.dataset.storageObject)])));
  $("storage-more").classList.toggle("hidden",!storageNext);
}
async function listStorage(more=false){
  const storeID=$("storage-select").value;
  if(!storeID){storageStatus("Storage connection required",true);return;}
  if(storageLoading)return;
  const request=++storageRequest,session=storageSession,prefix=$("storage-prefix").value;
  storageLoading=true;$("storage-list-button").disabled=true;$("storage-more").disabled=true;
  storageStatus("Reading storage…");
  try{
    const result=await api("/api/storage/objects",{store_id:storeID,prefix,...(more&&storageNext?{continuation_token:storageNext}:{})});
    if(request!==storageRequest||session!==storageSession)return;
    storageRows=more?[...storageRows,...result.objects]:result.objects;storageNext=result.next_token;renderStorageRows();
    storageStatus("Select dataset");
  }catch(error){if(request===storageRequest&&session===storageSession)storageStatus(error.message,true);}
  finally{if(request===storageRequest){storageLoading=false;$("storage-list-button").disabled=false;$("storage-more").disabled=false;}}
}
async function importDataset(body,options={}){
  const split=options.split||storageSplit,dialog=options.source!=="dropdown",background=true;
  if(!backgroundDatasetImports){notice("Connector update required",true);return;}
  if(!selectedCompute()){notice("SSH compute required",true);configure();return;}
  if(datasetImports[split])return;
  const session=storageSession,epoch=datasetConnectionEpoch,revision=++datasetRevision[split];
  const operation={split,revision,epoch,choice:options.choice||"",background,jobID:null,cancelRequested:false};
  if(background&&dialog)operation.onQueued=()=>{if(session===storageSession){$("storage-dialog").close();}};
  datasetImports[split]=operation;
  pendingFiles[split]=null;importingDatasets++;connectionUI(connected);
  if(dialog){storageStatus("Importing…");document.querySelectorAll(".storage-object").forEach(b=>b.disabled=true);}
  $(split+"-detail").textContent=background?"Import queued…":"Importing…";
  try{
    const data=await runDatasetJob(body,operation);
    if(!data||!importOperationCurrent(operation)||(!background&&dialog&&session!==storageSession))return;
    acceptDataset(split,data,options.choice||"");
    if(dialog&&session===storageSession){$("storage-dialog").close();}clearNotice();
  }catch(error){
    if(importOperationCurrent(operation)){
      const message=error.cancelled?"Import cancelled":importErrorMessage(error);
      $(split+"-detail").textContent=error.cancelled||message==="Import failed"?message:"Import failed · "+message;
      if(dialog&&session===storageSession)storageStatus(message,!error.cancelled);
      else if(!error.cancelled)notice(message,true);
    }
  }
  finally{
    if(datasetImports[split]===operation)datasetImports[split]=null;
    importingDatasets--;connectionUI(connected);
    if(epoch!==datasetConnectionEpoch&&revision===datasetRevision[split])$(split+"-detail").textContent=files[split]?datasetDetail(files[split]):"Reconnect to select dataset";
    if(dialog&&session===storageSession){renderStorageRows();}
  }
}
function importErrorMessage(error){return typeof error?.message==="string"&&error.message.trim()?error.message:"Import failed";}
function formatImportBytes(bytes){
  if(!Number.isFinite(bytes)||bytes<0)return "0 B";
  const unit=bytes>=1024**3?"GiB":bytes>=1024**2?"MiB":bytes>=1024?"KiB":"B",divisor={GiB:1024**3,MiB:1024**2,KiB:1024,B:1}[unit];
  return (bytes/divisor).toLocaleString(undefined,{maximumFractionDigits:1})+" "+unit;
}
function importOperationCurrent(operation){return connected&&operation.epoch===datasetConnectionEpoch&&operation.revision===datasetRevision[operation.split]&&datasetImports[operation.split]===operation;}
function importProgress(operation,job){
  if(!importOperationCurrent(operation))return;
  const read=Number(job.bytes_read)||0,total=Number(job.total_bytes)||0,rows=Number(job.rows)||0;
  const progress=[job.message||job.stage||job.status];
  if(job.compute_name||job.destination)progress.push(job.compute_name||job.destination);
  if(total||read)progress.push(formatImportBytes(read)+(total?" / "+formatImportBytes(total):""));
  if(Number.isFinite(job.rows))progress.push(rows.toLocaleString()+" rows");
  const text=progress.join(" · ");
  $(operation.split+"-detail").textContent=text;
  if(operation.annotation&&annotationDialogState===operation.annotation)$("annotations-status").textContent=text;
}
async function runDatasetJob(body,operation){
  const compute=body.compute||selectedCompute();
  if(!compute)throw new Error("SSH compute required");
  if(body.key&&/\.(csv|tsv)(\.gz)?$/i.test(body.key)){
    const format=$(operation.annotation?"annotations-table-format":"table-format").value||"auto";
    if(format!=="auto")body={...body,table_format:format};
    else if(/(?:^|\/)clusters?[_-](30|90|98)\.tsv(\.gz)?$/i.test(body.key))body={...body,table_format:"mmseqs_cluster"};
  }
  const queued=await api("/api/imports",{...body,compute});
  if(!/^[a-f0-9]{32}$/.test(queued.id||""))throw new Error("Invalid import reference");
  operation.jobID=queued.id;
  if(!importOperationCurrent(operation))return null;
  importProgress(operation,queued);
  if(operation.onQueued)operation.onQueued();
  if(operation.cancelRequested)await api("/api/imports/"+operation.jobID+"/cancel",{});
  while(importOperationCurrent(operation)){
    await new Promise(resolve=>setTimeout(resolve,1000));
    if(!importOperationCurrent(operation))return null;
    const job=await api("/api/imports/"+operation.jobID);
    if(!importOperationCurrent(operation))return null;
    importProgress(operation,job);
    if(job.status==="completed"){
      if(!job.dataset?.id)throw new Error("Imported dataset missing");
      return job.dataset;
    }
    if(job.status==="failed"||job.status==="cancelled"){
      const error=new Error(job.message||(job.status==="cancelled"?"Import cancelled":"Import failed"));
      error.cancelled=job.status==="cancelled";throw error;
    }
    if(!["queued","running"].includes(job.status))throw new Error("Invalid import status");
  }
  return null;
}
async function cancelDatasetImport(split){
  const operation=datasetImports[split];
  if(!operation?.background||operation.cancelRequested||!connected)return;
  operation.cancelRequested=true;renderDatasetChoices();renderAnnotationControls();
  if(!operation.jobID)return;
  try{await api("/api/imports/"+operation.jobID+"/cancel",{});}
  catch(error){if(importOperationCurrent(operation)){operation.cancelRequested=false;renderDatasetChoices();renderAnnotationControls();notice(importErrorMessage(error),true);}}
}
function importStorageObject(object){return importDataset({store_id:$("storage-select").value,key:object.key,etag:object.etag,selection_id:object.selection_id});}
function openAnnotations(split){
  const sequence=files[split];
  if(!connected||!backgroundDatasetImports||!sequence||datasetImports[split])return;
  annotationDialogState={split,sequence,epoch:datasetConnectionEpoch,revision:datasetRevision[split],annotations:null,choice:""};
  const rows=annotationTableRows();
  $("annotations-dataset-select").innerHTML='<option value="">Select file</option>'+rows.map(row=>`<option value="${esc(row.value)}">${esc(row.store.name)} · ${esc(row.object.key)}</option>`).join("");
  $("annotations-dataset-select").value="";
  $("annotations-table-format").value="auto";
  $("annotations-base-id").innerHTML=sequence.columns.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("");
  $("annotations-base-id").value=sequence.columns.find(c=>/^(protein_id|id|accession|acc)$/i.test(c))||"";
  $("annotations-allow-extra").checked=false;
  $("annotations-id-column").innerHTML='<option value="">No file imported</option>';
  $("annotations-status").textContent=rows.length?"Select metadata / sequences":"No metadata / sequence files · Refresh required";
  $("annotations-dialog-title").textContent="Metadata / sequences";
  renderAnnotationControls();$("annotations-dialog").showModal();
}
function annotationContextCurrent(context){return !!context&&connected&&context.epoch===datasetConnectionEpoch&&files[context.split]===context.sequence&&datasetRevision[context.split]===context.revision;}
function renderAnnotationControls(){
  const context=annotationDialogState,active=context&&datasetImports[context.split],valid=annotationContextCurrent(context);
  $("annotations-dataset-select").disabled=!valid||!!active;
  $("annotations-import").disabled=!valid||!!active||!$("annotations-dataset-select").value;
  $("annotations-id-column").disabled=!valid||!!active||!context?.annotations;
  $("annotations-base-id").disabled=!valid||!!active;
  $("annotations-allow-extra").disabled=!valid||!!active;
  $("annotations-join").disabled=!valid||!!active||!context?.annotations||!$("annotations-id-column").value||!$("annotations-base-id").value;
  $("annotations-cancel").classList.toggle("hidden",!active?.annotation);
  $("annotations-cancel").disabled=!connected||!!active?.cancelRequested;
}
async function importAnnotations(){
  const context=annotationDialogState;
  if(!annotationContextCurrent(context)||datasetImports[context.split])return;
  const row=annotationTableRows().find(candidate=>candidate.value===$("annotations-dataset-select").value);
  if(!row)return;
  context.annotations=null;context.choice=row.value;
  $("annotations-id-column").innerHTML='<option value="">Importing table…</option>';
  await annotationJob(context,{store_id:row.store.id,key:row.object.key,etag:row.object.etag,selection_id:row.object.selection_id},false);
}
async function joinAnnotations(){
  const context=annotationDialogState,column=$("annotations-id-column").value;
  if(!annotationContextCurrent(context)||datasetImports[context.split]||!context.annotations?.columns.includes(column))return;
  const baseColumn=$("annotations-base-id").value;
  if(!context.sequence.columns.includes(baseColumn))return;
  await annotationJob(context,{kind:"metadata-join",sequence_ref:context.sequence.id,annotations_ref:context.annotations.id,base_id_column:baseColumn,annotation_id_column:column,allow_unmatched_annotations:$("annotations-allow-extra").checked===true},true);
}
async function annotationJob(context,body,join){
  body={...body,compute:context.sequence.compute_id||selectedCompute()};
  const split=context.split,operation={split,revision:context.revision,epoch:context.epoch,choice:datasetChoices[split],background:true,jobID:null,cancelRequested:false,annotation:context};
  datasetImports[split]=operation;importingDatasets++;connectionUI(connected);renderAnnotationControls();
  try{
    const dataset=await runDatasetJob(body,operation);
    if(!dataset||!importOperationCurrent(operation)||!annotationContextCurrent(context))return;
    if(join){
      if(dataset.kind==="fasta")throw new Error("Metadata join failed");
      acceptDataset(split,dataset);context.revision=datasetRevision[split];
      if(annotationDialogState===context)$("annotations-dialog").close();
    }else{
      context.annotations=dataset;
      if(annotationDialogState===context){
        $("annotations-id-column").innerHTML='<option value="">Select ID column</option>'+dataset.columns.map(column=>`<option value="${esc(column)}">${esc(column)}</option>`).join("");
        $("annotations-id-column").value=dataset.columns.find(column=>/^(id|protein_id|accession)$/i.test(column))||"";
        $("annotations-status").textContent=dataset.rows.toLocaleString()+" rows imported";
      }
      $(split+"-detail").textContent=datasetDetail(context.sequence);
    }
  }catch(error){
    if(importOperationCurrent(operation)){
      const message=error.cancelled?"Import cancelled":importErrorMessage(error);
      $(split+"-detail").textContent=datasetDetail(context.sequence);
      if(annotationDialogState===context)$("annotations-status").textContent=message;
      if(!error.cancelled)notice(message,true);
    }
  }
  finally{
    if(datasetImports[split]===operation)datasetImports[split]=null;
    importingDatasets--;connectionUI(connected);renderAnnotationControls();
  }
}
function clearStorageCredentials(){
  for(const field of ["access_key_id","secret_access_key","session_token"])$("store-"+field).value="";
}
function storageConnectionTab(name){
  for(const tab of ["connection","options"]){const active=tab===name;$("store-"+tab+"-panel").classList.toggle("hidden",!active);$("store-"+tab+"-tab").classList.toggle("active",active);$("store-"+tab+"-tab").setAttribute("aria-selected",String(active));}
}
function storageCredentialsUI(){
  const method=$("store-auth").value,direct=method==="direct",supported=!connected||storageAuthMethods.includes("direct");
  document.querySelectorAll(".store-direct,.store-direct-fields").forEach(el=>el.classList.toggle("hidden",!direct));
  document.querySelectorAll(".store-env").forEach(el=>el.classList.toggle("hidden",method!=="env"));
  document.querySelectorAll(".store-profile").forEach(el=>el.classList.toggle("hidden",method!=="profile"));
  $("store-advanced-auth-note").classList.toggle("hidden",direct);$("store-credential-help").classList.toggle("hidden",!direct);
  $("store-capability-note").textContent=direct&&!supported?"Connector update required for access keys":"";
  $("save-storage").disabled=storageConnecting||(direct&&!supported);
}
function storageProviderDefaults(){
  clearStorageCredentials();const r2=$("store-provider").value==="r2";
  $("store-region").value=r2?"auto":"us-east-1";
  $("store-server").placeholder=r2?"<accountid>.r2.cloudflarestorage.com":"s3.amazonaws.com";
  $("store-access_key_env").value=r2?"R2_ACCESS_KEY_ID":"AWS_ACCESS_KEY_ID";
  $("store-secret_key_env").value=r2?"R2_SECRET_ACCESS_KEY":"AWS_SECRET_ACCESS_KEY";
}
function prefillStorageReconnect(store){
  reconnectingStorageID=store.id;$("store-provider").value=store.provider;storageProviderDefaults();
  $("store-server").value="";$("store-name").value=store.name;$("store-path").value="/"+store.bucket+"/"+(store.prefix||"");
  $("store-auth").value="direct";storageConnectionTab("connection");storageCredentialsUI();
}
function newStorageConnection(){
  reconnectingStorageID=null;clearStorageCredentials();$("storage-form").reset();storageProviderDefaults();storageConnectionTab("connection");storageCredentialsUI();
  $("storage-settings").open=true;$("store-server").focus();
}
async function connectStorage(event){
  event.preventDefault();
  const method=$("store-auth").value;
  const body={id:reconnectingStorageID||("store-"+randomID()),name:$("store-name").value.trim(),provider:$("store-provider").value,
    server:$("store-server").value.trim(),path:$("store-path").value.trim(),region:$("store-region").value.trim()||"auto"};
  if(method==="direct")Object.assign(body,{access_key_id:$("store-access_key_id").value.trim(),secret_access_key:$("store-secret_access_key").value,session_token:$("store-session_token").value,remember_credentials:$("store-remember").checked});
  clearStorageCredentials();
  if(storageConnecting)return;
  if(method==="direct"&&!storageAuthMethods.includes("direct")){storageStatus("Connector update required for access keys",true);return;}
  if(!body.server||!body.path){storageConnectionTab("connection");storageStatus("Server and /bucket/path required",true);return;}
  if(method==="direct"&&(!body.access_key_id||!body.secret_access_key)){storageConnectionTab("connection");storageStatus("Access Key ID and Secret Access Key required",true);return;}
  if(method!=="direct"){
    const parts=body.path.replace(/^\/+/,"").split("/");
    body.endpoint_url=/^https:\/\//i.test(body.server)?body.server:"https://"+body.server;body.bucket=parts.shift();body.prefix=parts.join("/");
    body.name=body.name||body.bucket;
    delete body.server;delete body.path;
    if(method==="profile")body.aws_profile=$("store-aws_profile").value.trim()||"default";
    else for(const field of ["access_key_env","secret_key_env","session_token_env"])body[field]=$("store-"+field).value.trim();
  }
  const session=storageSession;storageConnecting=true;storageCredentialsUI();storageStatus("Connecting…");
  try{
    const result=await api(method==="direct"?"/api/storage/connect":"/api/storage/profile",body);
    if(session!==storageSession)return;
    stores=[...stores.filter(p=>p.id!==result.profile.id),result.profile];renderStores();$("storage-select").value=result.profile.id;$("storage-prefix").value=result.profile.prefix||"";
    $("storage-settings").open=false;resetStorageListing();
    if(method==="direct"){storageRows=result.objects||[];storageNext=result.next_token||null;seedDatasetCatalog(result.profile,result);renderStorageRows();storageStatus("Connected");}
    else await listStorage();
    syncDatasetCatalog();
  }catch(error){if(session===storageSession)storageStatus(error.message,true);}
  finally{clearStorageCredentials();storageConnecting=false;storageCredentialsUI();}
}
async function finishConnection(value){
  token=value;
  const data=await api("/api/state",undefined,{timeout:15000});
  applyWorkspaceState(data);sessionStorage.setItem("foldguard-service-token",token);
  $("service-token").value=token;if($("connection-dialog").open)$("connection-dialog").close();clearNotice();await uploadPendingFiles();scheduleSummary();
}
async function startPairing(){
  if(localPage){try{const r=await fetch(base+"/api/bootstrap");if(!r.ok)throw new Error();await finishConnection((await r.json()).token);}catch(error){$("pair-status").textContent="Start connector · Retry";}return;}
  pairingState=randomID();clearTimeout(pairingTimer);pairingWindow=window.open(base+"/connect?state="+encodeURIComponent(pairingState),"foldguard-connect-"+pairingState,"popup,width=600,height=680");
  $("pair-status").textContent=pairingWindow?"Local approval required":"Popup blocked · Allow popups and retry";
  pairingTimer=setTimeout(()=>{pairingState="";$("pair-status").textContent="Approval expired · Retry";},180000);
}
window.addEventListener("message",async event=>{
  if(!pairingWindow||![new URL(base).origin,location.origin].includes(event.origin)||event.source!==pairingWindow||!pairingState||event.data?.type!=="foldguard:paired"||event.data.state!==pairingState||!validConnectionToken(event.data.token))return;
  const popup=pairingWindow,state=pairingState;
  clearTimeout(pairingTimer);pairingState="";
  try{
    await finishConnection(event.data.token);
    try{popup.postMessage({type:"foldguard:pair-ack",state},event.origin);popup.close();}catch(error){/* Connection already verified; a closed popup needs no acknowledgment. */}
    if(pairingWindow===popup)pairingWindow=null;
  }catch(error){connectionUI(false);$("pair-status").textContent="Connection failed · "+error.message;notice(error.message,true);}
});
function receivePairingFragment(){
  const fragment=new URLSearchParams(location.hash.slice(1));if(!fragment.has("connect_token"))return false;
  const value=fragment.get("connect_token"),state=fragment.get("state");history.replaceState(null,"",location.pathname+location.search);
  if(!/^[a-f0-9]{32}$/.test(state||"")||!validConnectionToken(value))return false;
  token=value;sessionStorage.setItem("foldguard-service-token",token);
  if(window.opener){try{window.opener.postMessage({type:"foldguard:paired",state,token:value},location.origin);setTimeout(()=>window.close(),200);}catch(error){/* This tab can connect independently. */}}
  return true;
}
function selectedCompute(){return selectedComputeID;}
function preferredCompute(data){
  const remote=profiles.filter(p=>p.kind!=="local");
  return remote.find(p=>p.id===data.active_compute_id)?.id||remote.find(p=>p.id===selectedComputeID)?.id||remote.find(p=>p.id==="adroit"&&p.workspace_configured)?.id||remote.find(p=>p.id==="ssh-gpu")?.id||remote[0]?.id||"";
}
function renderCompute(){
  const p=profiles.find(p=>p.id===selectedCompute()),check=checks[selectedCompute()];
  $("compute-name").textContent=p?.name||"SSH compute";
  $("compute-destination").textContent=p?.host?(p.host+(p.kind==="slurm"?" · Slurm":" · SSH")):"Not configured";
  $("compute-status").textContent=check?.ok?"● Connected":p?.workspace_configured?"Not checked":"Setup required";
  $("compute-status").classList.toggle("ready",!!check?.ok);
}
function configure(identifier=selectedCompute()){
  if(!connected){notice("Connector disconnected",true);showConnection();return;}
  activeProfile=profiles.find(p=>p.id===identifier&&p.kind!=="local")||profiles.find(p=>p.id==="ssh-gpu")||{id:"ssh-gpu",name:"My compute",kind:"ssh",device:"cuda",cpus:4,minutes:60,memory_gb:24};
  $("compute-dialog-title").textContent="SSH compute";
  for(const field of ["id","name","host","python","work_dir","model_dir","device","cpus","partition","minutes","memory_gb","ssh_socket"]){$("profile-"+field).value=activeProfile[field]??"";}
  for(const key of ["python","model_dir"]){$("profile-"+key).required=!activeProfile.assets_configured;$("profile-"+key).placeholder=activeProfile.assets_configured?"Configured · Leave blank to keep":"Required path";}
  $("profile-work_dir").required=!activeProfile.workspace_configured;$("profile-work_dir").placeholder=activeProfile.workspace_configured?"Configured · Leave blank to keep":"/absolute/path/to/foldguard-workspace";
  $("profile-slurm").checked=activeProfile.kind==="slurm";
  $("profile-preset").value=activeProfile.host?.endsWith("adroit.princeton.edu")?"adroit":"custom";
  computeSchedulerUI();terminalCommandUI();
  $("profile-check").textContent="";
  $("profile-check").className="profile-check";
  $("compute-dialog").showModal();
}
function computeSchedulerUI(){document.querySelectorAll(".slurm-field").forEach(e=>e.classList.toggle("hidden",!$("profile-slurm").checked));}
async function terminalCommandUI(){
  const revision=++terminalCommandRevision,host=$("profile-host").value.trim();
  $("ssh-terminal-note").textContent="Terminal sign-in required";
  $("copy-ssh-command").disabled=true;
  if(!/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host)){$("ssh-terminal-command").textContent="SSH host required";return;}
  $("ssh-terminal-command").textContent="Preparing command…";
  try{
    const result=await api("/api/compute/terminal-command",profileForm());
    if(revision!==terminalCommandRevision)return;
    if(typeof result.command!=="string"||!result.command.startsWith("ssh "))throw new Error();
    $("ssh-terminal-command").textContent=result.command;$("copy-ssh-command").disabled=false;
    if(typeof result.note==="string"&&/transfer node/i.test(result.note))$("ssh-terminal-note").textContent="Main + transfer node sign-in required";
  }catch(error){if(revision===terminalCommandRevision)$("ssh-terminal-command").textContent="Check SSH settings";}
}
function computePreset(){
  const adroit=$("profile-preset").value==="adroit";
  const preset=adroit?profiles.find(p=>p.id==="adroit"):profiles.find(p=>p.id==="ssh-gpu");
  if(preset){activeProfile=preset;for(const field of ["id","name","host","python","work_dir","model_dir","device","cpus","partition","minutes","memory_gb","ssh_socket"]){$("profile-"+field).value=preset[field]??"";}}
  else{$("profile-name").value=adroit?"Adroit":"My compute";$("profile-host").value=adroit?"adroit.princeton.edu":"";}
  for(const key of ["python","model_dir"]){$("profile-"+key).required=!activeProfile.assets_configured;$("profile-"+key).placeholder=activeProfile.assets_configured?"Configured · Leave blank to keep":"Required path";}
  $("profile-work_dir").required=!activeProfile.workspace_configured;
  $("profile-slurm").checked=adroit;computeSchedulerUI();terminalCommandUI();
}
function profileForm(){
  const result={...activeProfile};
  for(const field of ["name","host","python","work_dir","model_dir","device","cpus","partition","minutes","memory_gb","ssh_socket"]){result[field]=$("profile-"+field).value.trim();}
  result.kind=$("profile-slurm").checked?"slurm":"ssh";result.gpus=result.device==="cuda"?1:0;
  return result;
}
function renderRuns(){
  $("run-count").textContent=runs.length;
  $("runs-list").innerHTML=runs.length?runs.map(r=>`<article class="run-card"><div><h2>${esc(r.name)}</h2><p>${runTaskType(r)==="regression"?"Continuous value":"Discrete categories"} · ${esc(r.compute)} · ${r.summary.train_rows.toLocaleString()} train / ${r.summary.test_rows.toLocaleString()} test · ${new Date(r.created_at*1000).toLocaleString()}</p></div><div><span class="pill ${esc(r.status)}">${esc(r.status)}</span><button data-open-run="${r.id}">View run ↗</button></div></article>`).join(""):`<div class="empty-list">No runs</div>`;
  document.querySelectorAll("[data-open-run]").forEach(b=>b.addEventListener("click",async()=>{currentRun=b.dataset.openRun;previousView=null;selectedLoss="";changeView("builder");await refreshRun();window.scrollTo({top:0,behavior:"smooth"});}));
}
function plot(series,{xLabel="Training step",yLabel="Loss",diagonal=false,percentage=false}={}){
  const W=350,H=180,L=40,R=12,T=24,B=30;
  const points=series.flatMap(s=>s.points).filter(p=>p.every(Number.isFinite));
  if(!points.length)return "";
  const xmax=Math.max(1,...points.map(p=>p[0])),ymax=percentage?100:Math.max(.01,...points.map(p=>p[1]))*1.07;
  const x=v=>L+(W-L-R)*v/xmax,y=v=>H-B-(H-T-B)*v/ymax;
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)} versus ${esc(xLabel)}"><text class="plot-label" x="${L}" y="10">${esc(yLabel)}</text>`;
  for(let i=0;i<=3;i++){const value=ymax*i/3;svg+=`<path d="M${L} ${y(value)}H${W-R}" stroke="#c6c2b8" fill="none"/><text class="plot-label" x="${L-7}" y="${y(value)+3}" text-anchor="end">${percentage?value.toFixed(0)+"%":value.toFixed(2)}</text>`;}
  for(let i=0;i<=4;i++){const value=xmax*i/4;svg+=`<text class="plot-label" x="${x(value)}" y="${H-B+15}" text-anchor="middle">${Number.isInteger(xmax)?Math.round(value):value.toFixed(1)}</text>`;}
  if(diagonal)svg+=`<path d="M${x(0)} ${y(0)}L${x(1)} ${y(1)}" stroke="#c6d1bd" stroke-dasharray="4 4" fill="none"/>`;
  for(const s of series){
    const valid=s.points.filter(p=>p.every(Number.isFinite));
    svg+=`<path d="${valid.map((p,i)=>(i?"L":"M")+x(p[0]).toFixed(2)+" "+y(p[1]).toFixed(2)).join(" ")}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    if(valid.length===1)svg+=`<circle cx="${x(valid[0][0]).toFixed(2)}" cy="${y(valid[0][1]).toFixed(2)}" r="3" fill="${s.color}"/>`;
  }
  svg+=`<text class="plot-label" x="${(W+L-R)/2}" y="${H-1}" text-anchor="middle">${esc(xLabel)}</text></svg>`;
  return svg;
}
function lossTaskType(events,view){
  return events.some(e=>e.loss_metric==="mse")||(!events.some(e=>e.loss_metric==="log_loss")&&runTaskType(view)==="regression")?"regression":"classification";
}
function validLiveMetric(value,metric){
  return Number.isFinite(value)&&value>=0&&(!metric.percentage||value<=1);
}
function liveMetricText(value,metric){
  if(!validLiveMetric(value,metric))return "—";
  return metric.percentage?(value*100).toFixed(1)+"%":Number(value.toPrecision(4)).toString();
}
function renderLoss(events,view=previousView){
  const losses=events.filter(e=>e.event==="loss");
  const task=lossTaskType(losses,view),continuous=task==="regression";
  const definitions=[{value:"loss",label:continuous?"MSE":"Loss",axis:continuous?"Mean squared error":"Loss"},
    ...(continuous?[{value:"rmse",label:"RMSE",axis:"Root mean squared error"},{value:"mae",label:"MAE",axis:"Mean absolute error"}]:
      [{value:"accuracy",label:"Accuracy",axis:"Accuracy (%)",percentage:true},
       {value:"balanced_accuracy",label:"Balanced accuracy",axis:"Balanced accuracy (%)",percentage:true},
       {value:"macro_f1",label:"Macro F1",axis:"Macro F1 (%)",percentage:true}])];
  const available=definitions.filter(metric=>metric.value==="loss"||losses.some(e=>validLiveMetric(e["train_"+metric.value],metric)||validLiveMetric(e["validation_"+metric.value],metric)));
  const metric=available.find(item=>item.value===selectedLossMetric[task])||available[0];
  $("loss-metric").innerHTML=available.map(item=>`<option value="${item.value}">${item.label}</option>`).join("");
  $("loss-metric").value=metric.value;$("loss-metric").disabled=available.length===1;
  $("loss-train-value").textContent="—";$("loss-validation-value").textContent="—";
  $("loss-validation-legend").classList.add("hidden");
  if(!losses.length){
    selectedLoss="";$("loss-series").innerHTML='<option value="">Waiting for training</option>';$("loss-series").value="";
    $("loss-chart").className="chart-placeholder";$("loss-chart").innerHTML='<span class="chart-ghost">╱╲__</span><p>Pending</p>';
    return;
  }
  const keys=[...new Set(losses.map(e=>e.series))];

  $("loss-series").innerHTML=keys.map(key=>`<option value="${esc(key)}">${esc(key)}</option>`).join("");
  const chosen=selectedLoss&&keys.includes(selectedLoss)?selectedLoss:keys.at(-1);
  $("loss-series").value=chosen;
  const data=losses.filter(e=>e.series===chosen);
  const trainKey="train_"+metric.value,validationKey="validation_"+metric.value;
  const transform=value=>metric.percentage?value*100:value;
  const train=data.filter(e=>validLiveMetric(e[trainKey],metric));
  const series=[{color:"#3f7a3a",points:train.map(e=>[e.step,transform(e[trainKey])])}];
  const val=data.filter(e=>validLiveMetric(e[validationKey],metric));
  if(val.length)series.push({color:"#6f5fa5",points:val.map(e=>[e.step,transform(e[validationKey])])});
  $("loss-validation-legend").classList.toggle("hidden",!val.length);
  const latest=data.at(-1);
  $("loss-train-value").textContent=liveMetricText(latest?.[trainKey],metric);
  $("loss-validation-value").textContent=liveMetricText(latest?.[validationKey],metric);
  $("loss-chart").className="";$("loss-chart").innerHTML=plot(series,{yLabel:metric.axis,percentage:metric.percentage});
  if(!$("loss-chart").innerHTML)$("loss-chart").innerHTML='<p class="small">Metric unavailable</p>';
}
function predictionScatter(rawPoints){
  const points=(rawPoints||[]).filter(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite));
  if(!points.length)return '<p class="small">Predictions unavailable</p>';
  const W=350,H=235,L=53,R=15,T=25,B=43;
  const values=points.flat(),scale=Math.max(1,...values.map(Math.abs));
  const normalized=values.map(v=>v/scale),min=Math.min(...normalized),max=Math.max(...normalized);
  const pad=(max-min)*.06||Math.max(Math.abs(min)*.1,.1),lo=min-pad,hi=max+pad,span=hi-lo;
  const x=v=>L+(W-L-R)*(v/scale-lo)/span,y=v=>H-B-(H-T-B)*(v/scale-lo)/span;
  const nx=v=>L+(W-L-R)*(v-lo)/span,ny=v=>H-B-(H-T-B)*(v-lo)/span;
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Predicted versus actual values. Dashed line shows perfect agreement."><text class="plot-label" x="${L}" y="10">Predicted value</text>`;
  for(let i=0;i<=4;i++){
    const value=lo+span*i/4,label=esc(numberText(value*scale,2));
    svg+=`<path d="M${L} ${ny(value)}H${W-R}" stroke="#c6c2b8" fill="none"/><text class="plot-label" x="${L-7}" y="${ny(value)+3}" text-anchor="end">${label}</text><text class="plot-label" x="${nx(value)}" y="${H-B+16}" text-anchor="middle">${label}</text>`;
  }
  svg+=`<path d="M${nx(lo)} ${ny(lo)}L${nx(hi)} ${ny(hi)}" stroke="#77746d" stroke-dasharray="4 4" fill="none"/>`;
  for(const point of points)svg+=`<circle cx="${x(point[0]).toFixed(2)}" cy="${y(point[1]).toFixed(2)}" r="2.8" fill="#6f5fa5" fill-opacity=".65"><title>Actual ${esc(numberText(point[0]))}; predicted ${esc(numberText(point[1]))}</title></circle>`;
  return svg+`<text class="plot-label" x="${(W+L-R)/2}" y="${H-4}" text-anchor="middle">Actual value</text></svg>`;
}
function regressionMetrics(r){
  const m=r.metrics,d=r.dataset,baseline=m.baseline||r.baseline;
  const cards=[["RMSE",m.rmse],["Mean absolute error",m.mae],["R²",m.r2],["Pearson correlation",m.pearson]].map(([label,value])=>`<div><small>${label}</small><strong${Number.isFinite(value)?"":' class="undefined-metric"'}>${esc(numberText(value))}</strong></div>`).join("");
  const comparison=baseline?`<details class="result-details"><summary>Training-mean baseline</summary><div class="table-wrap"><table><thead><tr><th>Metric</th><th>Your model</th><th>Baseline</th></tr></thead><tbody>${[["RMSE","rmse"],["Mean absolute error","mae"],["R²","r2"]].map(([name,key])=>`<tr><td>${name}</td><td>${esc(numberText(m[key]))}</td><td>${esc(numberText(baseline[key]))}</td></tr>`).join("")}</tbody></table></div></details>`:"";
  return `<div class="metric-grid">${cards}</div><div class="metric-note">${d.test_rows.toLocaleString()} test proteins · Continuous value<br>${separationSummary(d)}<br>${r.training_limit_reached?"Training limit reached":"Complete"}</div><div class="prediction-heading">Predicted versus actual</div><div id="prediction-chart">${predictionScatter(m.prediction_points)}</div>${comparison}`;
}
function renderMetrics(view){
  const r=view.result;
  $("metrics-empty").classList.toggle("hidden",!!r);$("metrics-content").classList.toggle("hidden",!r);
  if(!r)return;
  if(renderedResultRun===view.id)return;
  renderedResultRun=view.id;
  const m=r.metrics,d=r.dataset,continuous=runTaskType(view)==="regression",classes=d.classes||[];
  const classification=`<div class="metric-grid"><div><small>AUROC${classes.length>2?" · macro OVR":""}</small><strong>${Number.isFinite(m.auroc)?m.auroc.toFixed(4):"Undefined"}</strong></div><div><small>Balanced accuracy</small><strong>${Number.isFinite(m.balanced_accuracy)?(m.balanced_accuracy*100).toFixed(1):"Undefined"}<span class="small">%</span></strong></div><div><small>Macro F1</small><strong>${Number.isFinite(m.macro_f1)?m.macro_f1.toFixed(3):"Undefined"}</strong></div><div><small>Average precision</small><strong>${Number.isFinite(m.average_precision)?m.average_precision.toFixed(3):"Undefined"}</strong></div></div><div class="metric-note">${d.test_rows.toLocaleString()} test proteins · ${esc(m.auroc_definition)}<br>${separationSummary(d)}<br>${r.training_limit_reached?"Training limit reached":"Complete"}</div><div class="curve-controls"><label>ROC curve<select id="roc-class">${classes.map((c,i)=>`<option value="${esc(c)}"${i===(classes.length===2?1:0)?" selected":""}>${esc(c)}</option>`).join("")}</select></label></div><div id="roc-chart"></div><details class="result-details"><summary>Confusion matrix &amp; class metrics</summary><div class="table-wrap"><table><thead><tr><th>Actual ↓ / predicted →</th>${classes.map(c=>`<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${(m.confusion_matrix||[]).map((row,i)=>`<tr><th>${esc(classes[i])}</th>${row.map(n=>`<td>${n}</td>`).join("")}</tr>`).join("")}</tbody></table></div><div class="table-wrap"><table><thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>F1</th><th>n</th></tr></thead><tbody>${(m.per_class||[]).map(c=>`<tr><td>${esc(c.label)}</td><td>${c.precision.toFixed(3)}</td><td>${c.recall.toFixed(3)}</td><td>${c.f1.toFixed(3)}</td><td>${c.support}</td></tr>`).join("")}</tbody></table></div><p class="table-caption">Calibration: unverified</p></details>`;
  $("metrics-content").innerHTML=(continuous?regressionMetrics(r):classification)+`<div class="result-warning">${evaluationWarnings(d,r.limitations)}</div><button class="primary" id="download-model">Evaluation report ↓</button>`;
  if(!continuous){
    const roc=()=>{$("roc-chart").innerHTML=plot([{color:"#6f5fa5",points:m.curves[$("roc-class").value].roc}],{xLabel:"False positive rate",yLabel:"True positive rate",diagonal:true});};
    $("roc-class").addEventListener("change",roc);roc();
  }
  $("download-model").addEventListener("click",async()=>{
    try{const blob=await api("/api/artifact/"+view.id,undefined,{blob:true});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="evaluation-"+view.id.slice(0,8)+".zip";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}catch(error){notice(error.message,true);}
  });
}
function renderMonitor(view){
  const s=view.status,completed=s.status==="completed";
  $("monitor-name").textContent=view.name;
  $("monitor-message").textContent=s.status==="failed"?(s.message||"Run failed"):({validating:"Checking datasets",dispatching:"Queued",starting:"Starting",preparing:"Preparing",training:"Training",testing:"Evaluating",completed:"Complete",cancelled:"Cancelled"}[s.stage]||s.status);
  $("run-badge").textContent=s.status;$("run-badge").className="pill "+s.status;
  $("stop-run").classList.toggle("hidden",["completed","failed","cancelled"].includes(s.status));
  const stages=["validating","starting","preparing","training","testing","completed"],index=stages.indexOf(s.stage);
  [...$("pipeline-steps").children].forEach((el,i)=>{const current=i===0?index>=0&&index<=2:i===1?index===3:index>=4;const done=i===0?index>2:i===1?index>3:completed;el.classList.toggle("active",current);el.classList.toggle("done",done);});
  let percent=completed?100:s.stage==="preparing"?5+55*(s.completed||0)/(s.total||1):s.stage==="training"?75:s.stage==="testing"?95:2;
  $("progress-track").classList.remove("hidden");$("progress-fill").style.width=percent+"%";
  $("progress-caption").textContent=view.compute+(view.dispatch.job_id?" · Job "+view.dispatch.job_id:"")+(s.stage==="preparing"?" · "+(s.completed||0)+" / "+s.total+" proteins":"");
  if(view.connection_error)$("progress-caption").textContent+=" · Connection interrupted: "+view.connection_error.message;
  renderLoss(view.events,view);
  renderMetrics(view);previousView=view;
}
async function refreshRun(){if(!currentRun||!connected)return;const view=await api("/api/runs/"+currentRun);renderMonitor(view);}
function applyWorkspaceState(data){
  backgroundDatasetImports=data.remote_dataset_imports===true;maxImportBytes=backgroundDatasetImports?(Number(data.max_import_bytes)||16*1024**3):24*1024**2;datasetFormats=Array.isArray(data.dataset_formats)?data.dataset_formats:["csv","tsv"];
  $("remote-import-limits").textContent=backgroundDatasetImports?"CSV / TSV / FASTA · "+formatImportBytes(maxImportBytes)+" max":"Connector update required";
  profiles=data.profiles;const nextCompute=preferredCompute(data);if(selectedComputeID&&nextCompute!==selectedComputeID){files.train=null;files.test=null;readyValidationID="";validationRevision++;}selectedComputeID=nextCompute;runs=data.runs;checks=data.checks;stores=data.stores||[];supportedTaskTypes=Array.isArray(data.task_types)?data.task_types:["classification"];storageAuthMethods=Array.isArray(data.storage_auth_methods)?data.storage_auth_methods:[];connectionUI(true);taskTypeHelp();storageCredentialsUI();renderCompute();renderRuns();
  $("curated-target-note").classList.toggle("hidden",!stores.some(s=>s.curated));
  if(stores.some(s=>s.curated))$("remote-import-limits").textContent="";
  syncDatasetCatalog();
}
async function refresh(){
  if(polling||!token)return;polling=true;
  try{const data=await api("/api/state",undefined,{timeout:15000});applyWorkspaceState(data);await refreshRun();}
  catch(error){connectionUI(false);if(currentRun)$("progress-caption").textContent="Connector disconnected · Reconnect";}
  finally{polling=false;}
}

document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>changeView(b.dataset.view)));
for(const split of ["train","test"]){
  $(split+"-dataset-select").addEventListener("change",()=>chooseDataset(split));
}
for(const split of ["train","test"]){
  $(split+"-import-cancel").addEventListener("click",()=>cancelDatasetImport(split));
  $(split+"-attach-annotations").addEventListener("click",()=>openAnnotations(split));
}
$("annotations-dataset-select").addEventListener("change",()=>{if(annotationDialogState){annotationDialogState.annotations=null;$("annotations-id-column").innerHTML='<option value="">No file imported</option>';}renderAnnotationControls();});
$("annotations-id-column").addEventListener("change",renderAnnotationControls);
$("annotations-base-id").addEventListener("change",renderAnnotationControls);
$("annotations-import").addEventListener("click",importAnnotations);
$("annotations-join").addEventListener("click",joinAnnotations);
$("annotations-cancel").addEventListener("click",()=>{if(annotationDialogState)cancelDatasetImport(annotationDialogState.split);});
$("annotations-dialog").addEventListener("close",()=>{annotationDialogState=null;});
$("cluster-holdout").addEventListener("change",changeClustering);
$("refresh-datasets").addEventListener("click",()=>syncDatasetCatalog(true));
$("more-datasets").addEventListener("click",()=>syncDatasetCatalog(false,true));
for(const id of ["sequence-column","label-column","id-column","group-column"])$(id).addEventListener("change",scheduleSummary);
$("task-type").addEventListener("change",updateTaskType);
for(const id of ["connection-button","open-connection"])$(id).addEventListener("click",showConnection);
$("pair-service").addEventListener("click",startPairing);
document.querySelectorAll("[data-storage-split]").forEach(b=>b.addEventListener("click",()=>openStorage(b.dataset.storageSplit)));
$("storage-dialog").addEventListener("close",()=>{clearStorageCredentials();reconnectingStorageID=null;storageSession++;resetStorageListing();});
$("add-storage").addEventListener("click",newStorageConnection);
$("storage-select").addEventListener("change",()=>{resetStorageListing();reconnectingStorageID=null;const selected=stores.find(p=>p.id===$("storage-select").value);$("storage-prefix").value=selected?.prefix||"";if(selected?.configured===false){prefillStorageReconnect(selected);$("storage-settings").open=true;storageStatus("Storage credentials required");}else if(selected)listStorage();});
$("storage-prefix").addEventListener("input",resetStorageListing);
$("storage-list-form").addEventListener("submit",e=>{e.preventDefault();listStorage(false);});
$("storage-more").addEventListener("click",()=>listStorage(true));
$("store-auth").addEventListener("change",()=>{clearStorageCredentials();storageCredentialsUI();});
$("store-connection-tab").addEventListener("click",()=>storageConnectionTab("connection"));
$("store-options-tab").addEventListener("click",()=>storageConnectionTab("options"));
$("store-provider").addEventListener("change",storageProviderDefaults);
$("storage-form").addEventListener("submit",connectStorage);

$("configure-compute").addEventListener("click",()=>configure());
$("profile-slurm").addEventListener("change",computeSchedulerUI);
$("profile-preset").addEventListener("change",computePreset);
for(const id of ["profile-host","profile-ssh_socket"])$(id).addEventListener("input",terminalCommandUI);
$("copy-ssh-command").addEventListener("click",async()=>{try{await navigator.clipboard.writeText($("ssh-terminal-command").textContent);$("profile-check").textContent="Copied · Terminal sign-in required";}catch(error){$("profile-check").textContent="Copy command manually";}});
$("copy-token").addEventListener("click",async()=>{try{await navigator.clipboard.writeText(token);$("copy-token").textContent="Copied ✓";}catch(error){$("service-token").type="text";$("service-token").select();}});
$("connect-service").addEventListener("click",async()=>{
  const button=$("connect-service");button.disabled=true;
  try{token=$("service-token").value.trim();await api("/api/state",undefined,{timeout:15000});sessionStorage.setItem("foldguard-service-token",token);connectionUI(true);$("connection-dialog").close();clearNotice();await refresh();await uploadPendingFiles();}
  catch(error){notice("Connection failed · Check connector, token and local-network access · "+error.message,true);}
  finally{button.disabled=false;}
});
$("test-compute").addEventListener("click",async()=>{
  const button=$("test-compute");button.disabled=true;$("profile-check").className="profile-check";$("profile-check").textContent="Checking compute…";
  try{const result=await api("/api/check",profileForm());checks[activeProfile.id]=result;$("profile-check").textContent=(result.ok?"✓ ":"")+result.message+(result.host?" · "+result.host:"");$("profile-check").classList.toggle("error",!result.ok);renderCompute();}
  catch(error){$("profile-check").textContent=error.message;$("profile-check").classList.add("error");}
  finally{button.disabled=false;}
});
$("compute-form").addEventListener("submit",async e=>{
  e.preventDefault();
  try{
    const saved=await api("/api/profile",profileForm());
    for(const split of ["train","test"]){files[split]=null;datasetChoices[split]="";datasetRevision[split]++;$(split+"-filename").textContent="";$(split+"-detail").textContent="";$(split+"-drop").classList.remove("filled");}
    selectedComputeID=saved.id;readyValidationID="";validationRevision++;$("compute-dialog").close();datasetChanged();await refresh();
    notice("Compute saved");
  }catch(error){$("profile-check").textContent=error.message;$("profile-check").classList.add("error");}
});
$("launch-run").addEventListener("click",async()=>{
  if(!connected){showConnection();return;}if(!supportsTask()){notice("Connector update required for regression",true);return;}if(importingDatasets||pendingFiles.train||pendingFiles.test){notice("Import in progress",true);return;}if(!files.train?.id||!files.test?.id){notice("Training and test sets required",true);return;}if(files.train.kind==="fasta"||files.test.kind==="fasta"){notice("Annotations required for FASTA datasets",true);return;}
  if(!selectedCompute()||!readyValidationID){notice("Dataset checks pending",true);return;}
  busy=true;connectionUI(true);$("launch-run").textContent="Launching…";clearNotice();
  try{const response=await api("/api/runs",{...datasetPayload(),
    annotation:mapping().label,name:$("run-name").value.trim()||(mapping().label+" · v1"),compute:selectedCompute(),validation_id:readyValidationID});
    currentRun=response.id;previousView=null;selectedLoss="";await refresh();notice("Run launched");}
  catch(error){notice(error.message,true);}finally{busy=false;$("launch-run").innerHTML='Build &amp; evaluate <span>↗</span>';connectionUI(connected);}
});
$("loss-series").addEventListener("change",()=>{selectedLoss=$("loss-series").value;if(previousView)renderLoss(previousView.events);});
$("loss-metric").addEventListener("change",()=>{if(previousView){selectedLossMetric[lossTaskType(previousView.events,previousView)]=$("loss-metric").value;renderLoss(previousView.events);}});
$("stop-run").addEventListener("click",async()=>{if(!currentRun)return;try{const result=await api("/api/runs/"+currentRun+"/cancel",{});notice(result.message||"Stop requested");}catch(error){notice(error.message,true);}});

async function initialize(){
  receivePairingFragment();connectionUI(false);renderCompute();renderRuns();
  if(localPage){
    try{const r=await fetch(base+"/api/bootstrap");const data=await r.json();token=data.token;sessionStorage.setItem("foldguard-service-token",token);}
    catch(error){notice("Start connector",true);}
  }
  await refresh();
  if(!connected&&!localPage)notice("Connector disconnected");
  setInterval(()=>{if(!document.hidden)refresh();},4000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)refresh();});
}
initialize();
