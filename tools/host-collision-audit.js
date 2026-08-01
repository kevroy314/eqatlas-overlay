(()=>{
 const panel=document.getElementById('eqtrail-panel');
 const ourEls=[...panel.querySelectorAll('*'),...document.querySelectorAll('#eqtrail-stats *')];
 const hostSheets=[...document.styleSheets].filter(sh=>!(sh.ownerNode&&sh.ownerNode.dataset&&sh.ownerNode.dataset.eqtrail));
 const hostRules=[];
 for(const sh of hostSheets){let r;try{r=sh.cssRules}catch(e){continue}
   for(const x of r||[]) if(x.selectorText) hostRules.push(x);}

 // (1) A real collision = a host rule whose MATCHING PART is class-based.
 const collisions=[];
 for(const rule of hostRules){
   for(const part of rule.selectorText.split(',').map(s=>s.trim())){
     if(!part.includes('.')) continue;                 // element-only reset: not a collision
     for(const el of ourEls){ try{ if(el.matches(part)){
       collisions.push(part+'  ->  '+el.tagName+'.'+String(el.className)); break; } }catch(e){} }
   }}

 // (2) Is the HOST positioning any of our elements? (our own absolutes are fine)
 const hostPositioned=[];
 for(const el of ourEls){
   const p=getComputedStyle(el).position;
   if(p!=='absolute'&&p!=='fixed') continue;
   for(const rule of hostRules){
     if(!rule.style || !rule.style.position) continue;
     for(const part of rule.selectorText.split(',').map(s=>s.trim())){
       try{ if(el.matches(part)) hostPositioned.push(part+' -> '+el.tagName+'.'+String(el.className)); }catch(e){}
     }}}
 return JSON.stringify({collisions:[...new Set(collisions)], hostPositioned:[...new Set(hostPositioned)]});
})()
/* Paste into the console on an eqltools.com Atlas page with EQ Trail loaded.

   Answers two questions the build cannot:
     collisions     — does a CLASS-based host selector match an element we created?
     hostPositioned — does a HOST rule set `position` on one of our elements?

   Both must be empty. Element-level host rules (`*`, `a`, `button`) legitimately match ours and are
   deliberately not counted; our own absolutely-positioned elements (the heat legend ticks) are not
   counted either — only the host doing it to us.

   Validated against v0.7.0, where it correctly reports:
     collisions:     ['.hint  ->  DIV.hint']
     hostPositioned: ['.hint -> DIV.hint']                                    (issue #4) */
