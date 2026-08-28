(() => {
  const CLASS='__toggle_color_theme_active';
  const MEDIA_SEL='img, picture, video, iframe';
  const html=document.documentElement;
  const isEnabled=html.classList.contains(CLASS) && html.dataset.__toggle_enabled==='1';

  function hasBgImage(el){
    try{
      if(!(el instanceof HTMLElement)) return false;
      const bg = getComputedStyle(el).backgroundImage;
      return bg && bg !== 'none' && bg.includes('url(');
    }catch{ return false; }
  }

  function restore(el, cls){
    try{
      if(!el || !el.style) return;
      el.style.setProperty('filter','invert(1) hue-rotate(180deg)','important');
      el.style.setProperty('-webkit-filter','invert(1) hue-rotate(180deg)','important');
      if(cls) el.classList.add(cls);
    }catch{}
  }

  function fixMedia(root){
    try{
      if(root instanceof HTMLElement){
        if(root.matches && root.matches(MEDIA_SEL)){
          restore(root, root.tagName==='IFRAME' ? '__preserve-iframe' : '__preserve-img');
        } else if(hasBgImage(root)){
          restore(root, '__has-bg-img');
        }
      }
      const list=root.querySelectorAll?root.querySelectorAll(MEDIA_SEL):[];
      for(let i=0;i<list.length;i++) restore(list[i], list[i].tagName==='IFRAME' ? '__preserve-iframe' : '__preserve-img');
      
      // div背景画像も保護
      const all=root.querySelectorAll?root.querySelectorAll('*'):[];
      for(let i=0;i<all.length;i++){
        const el=all[i];
        if(el.matches && el.matches(MEDIA_SEL)) continue;
        if(hasBgImage(el)){
          restore(el, '__has-bg-img');
        }
      }
    }catch{}
  }

  if(isEnabled){
    try{ if(window.__toggleObserver){ window.__toggleObserver.disconnect(); window.__toggleObserver=null; } }catch{}
    html.dataset.__toggle_enabled='0';
    html.classList.remove(CLASS);
    try{
      document.querySelectorAll('.__preserve-img, .__preserve-iframe, .__has-bg-img').forEach(el=>{
        el.style.removeProperty('filter');
        el.style.removeProperty('-webkit-filter');
        el.classList.remove('__preserve-img');
        el.classList.remove('__preserve-iframe');
        el.classList.remove('__has-bg-img');
      });
    }catch{}
    return false;
  } else {
    html.classList.add(CLASS);
    html.dataset.__toggle_enabled='1';
    fixMedia(document);
    if(window.__toggleObserver){ try{ window.__toggleObserver.disconnect(); }catch{} }
    const obs=new MutationObserver((muts)=>{
      if(html.dataset.__toggle_enabled!=='1'){ obs.disconnect(); return; }
      for(const mut of muts){
        if(mut.type==='childList'){
          for(const node of mut.addedNodes){
            if(!(node instanceof HTMLElement)) continue;
            fixMedia(node);
          }
        }
      }
    });
    obs.observe(document.documentElement,{childList:true, subtree:true});
    window.__toggleObserver=obs;
    return true;
  }
})();
