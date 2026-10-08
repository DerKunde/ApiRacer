interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
    requestPermission?: () => Promise<'granted' | 'denied'>;
}

export async function requestOrientationEventPermission(): Promise<boolean>{
    const requestPermission = (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission;
    const iOS = typeof requestPermission === 'function';
    if(iOS){
        try{
            const response = await requestPermission();
            if(response === 'granted'){
                return true;
            }
            else{
                return false;
            }
        }
        catch(error){
            // z. B. NotAllowedError, wenn nicht direkt durch einen Klick ausgelöst
            console.error('requestPermission fehlgeschlagen:', error);
            return false;
        }
    }else{
        return true;
    }
}