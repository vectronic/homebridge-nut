import {
    PlatformAccessory,
    Service
} from 'homebridge';
import { NutHomebridgePlatform } from './platform';

export type Ups = {
    key: string;
    name: string;
    fault: boolean;
    active: boolean;
    onBattery: boolean;
    temperature: number;
    batteryLevel: number;
    chargingState: number;
    lowBattery: boolean;
    powerConsumption: number;
    powerConsumptionLevel: number;
    manufacturer: string;
    model: string;
    serialNumber: string;
    firmwareRevision: string;
}

/**
 * Nut UPS Accessory
 */
export class NutUPSAccessory {
    private contactSensorService: Service;
    private batteryService: Service;

    constructor(
        private readonly platform: NutHomebridgePlatform,
        accessory: PlatformAccessory,
        ups: Ups
    ) {
        // set accessory information
        accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, ups.manufacturer)
            .setCharacteristic(this.platform.Characteristic.Model, ups.model)
            .setCharacteristic(this.platform.Characteristic.SerialNumber, ups.serialNumber)
            .setCharacteristic(this.platform.Characteristic.FirmwareRevision, ups.firmwareRevision)
            .setCharacteristic(this.platform.Characteristic.Name, ups.name);

        // get the ContactSensor service if it exists, otherwise create a new ContactSensor service
        if (accessory.getService(this.platform.Service.ContactSensor)) {
            this.contactSensorService = accessory.getService(this.platform.Service.ContactSensor) as Service;
        } else {
            this.contactSensorService = accessory.addService(this.platform.Service.ContactSensor);

            this.contactSensorService.addCharacteristic(this.platform.Characteristic.StatusActive);
            this.contactSensorService.addCharacteristic(this.platform.Characteristic.StatusFault);
            this.contactSensorService.addCharacteristic(this.platform.Characteristic.CurrentTemperature);

            // TODO: workout how to define new characteristics
            // contactSensorService.addCharacteristic(Characteristic.UpsPowerConsumption);
            // contactSensorService.addCharacteristic(Characteristic.UpsPowerConsumptionLevel);
        }

        // set default initial state
        this.contactSensorService.setCharacteristic(this.platform.Characteristic.StatusFault,
            this.platform.Characteristic.StatusFault.NO_FAULT);
        this.contactSensorService.setCharacteristic(this.platform.Characteristic.ContactSensorState,
            this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
        this.contactSensorService.setCharacteristic(this.platform.Characteristic.StatusActive, 0);
        this.contactSensorService.setCharacteristic(this.platform.Characteristic.CurrentTemperature, 0);

        // TODO: workout how to define new characteristics
        // this.contactSensorService.setCharacteristic(this.platform.Characteristic.UpsPowerConsumption, 0);
        // this.contactSensorService.setCharacteristic(this.platform.Characteristic.UpsPowerConsumptionLevel, 0);
        
        // set the service name, this is what is displayed as the default name on the Home app
        this.contactSensorService.setCharacteristic(this.platform.Characteristic.Name, ups.name);

        // get the Battery service if it exists, otherwise create a new Battery service
        if (accessory.getService(this.platform.Service.BatteryService)) {
            this.batteryService = accessory.getService(this.platform.Service.BatteryService) as Service;
        } else {
            this.batteryService = accessory.addService(this.platform.Service.BatteryService);
        }

        // set default initial state
        this.batteryService.setCharacteristic(this.platform.Characteristic.BatteryLevel, 0);
        this.batteryService.setCharacteristic(this.platform.Characteristic.ChargingState,
            this.platform.Characteristic.ChargingState.CHARGING);
        this.batteryService.setCharacteristic(this.platform.Characteristic.StatusLowBattery,
            this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);

        // set the service name, this is what is displayed as the default name on the Home app
        this.batteryService.setCharacteristic(this.platform.Characteristic.Name, ups.name);
    }

    /**
     * Handle update from nut client
     */
    update(ups: Ups) {

        this.platform.log.debug('update()');

        this.contactSensorService.updateCharacteristic(this.platform.Characteristic.StatusFault,
            ups.fault ?
                this.platform.Characteristic.StatusFault.GENERAL_FAULT :
                this.platform.Characteristic.StatusFault.NO_FAULT);

        this.contactSensorService.updateCharacteristic(this.platform.Characteristic.ContactSensorState,
            ups.onBattery ?
                this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED :
                this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED);

        this.contactSensorService.updateCharacteristic(this.platform.Characteristic.StatusActive,
            ups.active ? 1 : 0);

        if (!isNaN(ups.temperature)) {
            this.contactSensorService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature,
                ups.temperature);
        }

        // TODO: workout how to define new characteristics
        // this.contactSensorService.updateCharacteristic(this.platform.Characteristic.UpsPowerConsumption,
        // ups.powerConsumption);
        // this.contactSensorService.updateCharacteristic(this.platform.Characteristic.UpsPowerConsumptionLevel,
        // ups.powerConsumptionLevel);

        this.batteryService.updateCharacteristic(this.platform.Characteristic.BatteryLevel, ups.batteryLevel);

        this.batteryService.updateCharacteristic(this.platform.Characteristic.ChargingState, ups.chargingState);

        this.batteryService.updateCharacteristic(this.platform.Characteristic.StatusLowBattery,
            ups.lowBattery ?
                this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW :
                this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);

        this.platform.log.debug(`pushed changed UPS state to HomeKit for ${ups.key}=${ups.name}`);
    }
}
