export function isPortrait(): boolean{
    if('orientation' in screen){
        return screen.orientation.type.startsWith('portrait');
    }

    return window.matchMedia('(orientation: portrait)').matches;
}

export function onScreenOrientationChange(callback: (portrait: boolean) => void): void{
    if('orientation' in screen){
        screen.orientation.addEventListener('change', () => callback(isPortrait()));
    } else{
        window.matchMedia('(orientation: portrait)').addEventListener('change', () => callback(isPortrait()));
    }
}