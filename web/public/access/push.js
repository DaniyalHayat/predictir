self.addEventListener('push',event=>{
  event.waitUntil(self.registration.showNotification('Predictir',{
    body:'A visitor requested access.',
    tag:'predictir-access-request',
    icon:'/favicon.svg',
  }));
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const url=new URL('/access/manage',self.location.origin).href;
  event.waitUntil((async()=>{
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const open=clients.find(client=>client.url===url);
    if(open){await open.focus();open.postMessage('predictir-access-request');return;}
    await self.clients.openWindow(url);
  })());
});
