export type RoomWorldId='cozy'|'arcade'|'space'|'beach';
export const ROOM_WORLDS={
  cozy:{name:'Cozy',trail:'#ffd29e',snap:'#ffd29e',sound:'fireplace'},
  arcade:{name:'Arcade',trail:'#74f7fc',snap:'#ff76f4',sound:'synth'},
  space:{name:'Space',trail:'#b2c6ff',snap:'#a4c8ff',sound:'synth'},
  beach:{name:'Beach',trail:'#80eadd',snap:'#f7dfae',sound:'ocean'},
} as const;
export function roomWorld(theme?:string){return ROOM_WORLDS[theme as RoomWorldId]??ROOM_WORLDS.cozy;}
