import {
    PlatformAccessory,
    CharacteristicGetCallback,
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

    private readonly key: string;
    private readonly name: string;
    
    constructor(
        private readonly platform: NutHomebridgePlatform,
        private readonly accessory: PlatformAccessory,
        private readonly ups: Ups
    ) {
        this.key = ups.key;
        this.name = ups.name;

        // set accessory information
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, ups.manufacturer)
            .setCharacteristic(this.platform.Characteristic.Model, ups.model)
            .setCharacteristic(this.platform.Characteristic.SerialNumber, ups.serialNumber)
            .setCharacteristic(this.platform.Characteristic.FirmwareRevision, ups.firmwareRevision)
            .setCharacteristic(this.platform.Characteristic.Name, this.name);

        // get the ContactSensor service if it exists, otherwise create a new ContactSensor service
        if (this.accessory.getService(this.platform.Service.ContactSensor)) {
            this.contactSensorService = this.accessory.getService(this.platform.Service.ContactSensor) as Service;
        } else {
            this.contactSensorService = this.accessory.addService(this.platform.Service.ContactSensor);

            this.contactSensorService.addCharacteristic(this.platform.Characteristic.StatusActive);
            this.contactSensorService.addCharacteristic(this.platform.Characteristic.StatusFault);
            this.contactSensorService.addCharacteristic(this.platform.Characteristic.CurrentTemperature);

            // TODO: workout how to define new characteristics
            // contactSensorService.addCharacteristic(Characteristic.UpsPowerConsumption);
            // contactSensorService.addCharacteristic(Characteristic.UpsPowerConsumptionLevel);
        }

        // set the service name, this is what is displayed as the default name on the Home app
        this.contactSensorService.setCharacteristic(this.platform.Characteristic.Name, this.name);

        // register handler for the contact sensor on characteristic
        this.contactSensorService.getCharacteristic(this.platform.Characteristic.ContactSensorState)
            .on('get', this.getState.bind(this));

        // get the Battery service if it exists, otherwise create a new Battery service
        if (this.accessory.getService(this.platform.Service.BatteryService)) {
            this.batteryService = this.accessory.getService(this.platform.Service.BatteryService) as Service;
        } else {
            this.batteryService = this.accessory.addService(this.platform.Service.BatteryService);
        }

        // set the service name, this is what is displayed as the default name on the Home app
        this.batteryService.setCharacteristic(this.platform.Characteristic.Name, this.name);

        // register handler for the contact sensor state
        this.contactSensorService.getCharacteristic(this.platform.Characteristic.ContactSensorState)
            .on('get', this.getState.bind(this));

        // register handler for the battery level
        this.contactSensorService.getCharacteristic(this.platform.Characteristic.BatteryLevel)
            .on('get', this.getState.bind(this));
    }

    /**
     * Handle the "GET" requests from HomeKit
     * These are sent when HomeKit wants to know the current state of the accessory.
     */
    getState(callback: CharacteristicGetCallback) {

        this.platform.log.debug('getState()');

        this.platform.pollNutDevice(this.key, this.name)
            .catch((err) => {
                this.platform.log.error(`error calling pollNutDevice, probably an ongoing request: ${err}`);
                callback(err);
            })
            .finally(() => callback(null));
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
                this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED :
                this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

        this.contactSensorService.updateCharacteristic(this.platform.Characteristic.StatusActive,
            ups.active ? 1 : 0);

        this.contactSensorService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, ups.temperature);

        // TODO: workout how to define new characteristics
        // this.contactSensorService.updateCharacteristic(this.platform.Characteristic.UpsPowerConsumption, ups.powerConsumption);
        // this.contactSensorService.updateCharacteristic(this.platform.Characteristic.UpsPowerConsumptionLevel, ups.powerConsumptionLevel);

        this.batteryService.updateCharacteristic(this.platform.Characteristic.BatteryLevel, ups.batteryLevel);

        this.batteryService.updateCharacteristic(this.platform.Characteristic.ChargingState, ups.chargingState);

        this.batteryService.updateCharacteristic(this.platform.Characteristic.StatusLowBattery,
            ups.lowBattery ?
                this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW :
                this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);

        this.platform.log.debug(`pushed updated current UPS state to HomeKit for ${this.key}=${this.name}`);
    }
}
