import {
    API,
    APIEvent,
    DynamicPlatformPlugin,
    Logger,
    PlatformAccessory,
    PlatformConfig,
    Service,
    Characteristic
} from 'homebridge';
import Nut from 'node-nut';
import { isEmpty } from 'lodash';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { NutUPSAccessory, Ups } from './nutUpsAccessory';

/**
 * NutHomebridgePlatform
 */
export class NutHomebridgePlatform implements DynamicPlatformPlugin {

    public readonly Service: typeof Service = this.api.hap.Service;
    public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

    // this is used to track restored cached accessories
    public readonly existingAccessories: PlatformAccessory[] = [];

    // this is used to have a reference to UPS accessory handles to update state after polling nut client
    private upsByUpsKey = new Map<string, NutUPSAccessory>();

    // this is true if we last received a nutReady (and not a nutClose) event
    private nutConnected = false;

    // this will be populated with the list of devices returned from the nut client
    private upsList;

    private readonly host: string;
    private readonly port: number;
    private readonly pollInterval: number;
    private readonly lowBattThreshold: number;

    private nutClient;

    constructor(
        public readonly log: Logger,
        public readonly config: PlatformConfig,
        public readonly api: API
    ) {
        log.debug('finished initializing platform');

        this.host = config.host || 'localhost';
        this.port = config.port || 3493;
        this.pollInterval = config.poll_interval || 60;
        this.lowBattThreshold = config.low_batt_threshold || 40;

        // When this event is fired it means Homebridge has restored all cached accessories from disk.
        api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
            log.debug('executing didFinishLaunching callback');

            this.startNutClient();
        });
    }

    /**
     * This function is invoked when homebridge restores cached accessories from disk at startup.
     * It should be used to setup event handlers for characteristics and update respective values.
     */
    configureAccessory(accessory: PlatformAccessory) {
        this.log.info(`loading accessory from cache: ${accessory.displayName}`);

        // add the restored accessory to the accessories cache so we can track if it has already been registered
        this.existingAccessories.push(accessory);
    }

    createOrUpdateUps(ups: Ups) {
        this.log.debug(`createOrUpdateUps(): ${ups.key}`);

        // check if we already have an accessory handler for this UPS
        if (this.upsByUpsKey.has(ups.key)) {

            // update the existing handler
            const nutUPSAccessory = this.upsByUpsKey.get(ups.key);
            
            if (nutUPSAccessory) {
                nutUPSAccessory.update(ups);
            }

            return;
        }

        // otherwise we need to construct a handler
        const uuid = this.api.hap.uuid.generate(ups.key);

        // see if an accessory with the same uuid has already been registered and restored from
        // the cached devices we stored in the `configureAccessory method above
        const existingAccessory = this.existingAccessories.find(accessory => accessory.UUID === uuid);

        let nutUPSAccessory;

        if (existingAccessory) {
            // the accessory already exists
            this.log.info(`found existing accessory for UUID: ${uuid} => ${existingAccessory.displayName}`);

            // create the accessory handler for the restored accessory
            nutUPSAccessory = new NutUPSAccessory(this, existingAccessory, ups);

            this.upsByUpsKey.set(ups.key, nutUPSAccessory);
        } else {
            // the accessory does not yet exist, so we need to create it
            this.log.info(`adding new accessory: ${ups.name}`);

            // create a new accessory
            const accessory = new this.api.platformAccessory(ups.name, uuid);

            // create the accessory handler for the newly created accessory
            nutUPSAccessory = new NutUPSAccessory(this, accessory, ups);
            this.upsByUpsKey.set(ups.name, nutUPSAccessory);

            // link the accessory to your platform
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
        
        // now that we know an accessory exists, update it
        nutUPSAccessory.update(ups);
    }

    parseUpsVars(upsKey, upsName, upsVars) {
        this.log.debug(`parseUpsVars(${upsKey})`);

        const upsInfo = {};

        this.log.debug(`UPS info for device: ${upsKey}=${upsName} =>`);

        Object.entries(upsVars).forEach(([key, value]) => {

            this.log.debug(`${key}=${value}`);
            upsInfo[key] = value;
        });

        let active = false;
        if ('ups.load' in upsInfo) {
            const load = parseInt(upsInfo['ups.load']);
            active = (load !== undefined) && !isNaN(load) && (load > 0);
        }

        let onBattery = false;
        if ('ups.status' in upsInfo) {
            const status = upsInfo['ups.status'] as string;
            onBattery = status.startsWith('OB');
        }

        let temperature = -1;
        if ('ups.temperature' in upsInfo) {
            const temp = parseFloat(upsInfo['ups.temperature']);
            if ((temp !== undefined) && !isNaN(temp)) {
                temperature = temp;
            }
        }
        
        let batteryLevel = 0;
        if ('battery.charge' in upsInfo) {
            const charge = parseFloat(upsInfo['battery.charge']);
            if ((charge !== undefined) && !isNaN(charge)) {
                batteryLevel = charge;
            }
        }

        let chargingState = this.Characteristic.ChargingState.NOT_CHARGING;
        if ('ups.status' in upsInfo) {
            const upsStatus = upsInfo['ups.status'] as string;
            if (upsStatus === 'OL CHRG' || upsStatus === 'OL') {
                chargingState = this.Characteristic.ChargingState.CHARGING;
            } else if (upsStatus === 'OB DISCHRG' || upsStatus === 'OB') {
                chargingState = this.Characteristic.ChargingState.NOT_CHARGEABLE;
            }
        }

        let powerConsumption = 0;
        let powerConsumptionLevel = 0;
        
        if (('ups.status' in upsInfo) && ('ups.power.nominal' in upsInfo)) {
            const loadPercent = parseInt(upsInfo['ups.load']);
            const nominalPower = parseInt(upsInfo['ups.power.nominal']);

            if ((loadPercent !== undefined) && !isNaN(loadPercent)) {
                powerConsumptionLevel = loadPercent;

                if ((nominalPower !== undefined) && !isNaN(nominalPower)) {
                    powerConsumption = Math.round(loadPercent * 0.01 * nominalPower * 0.8);
                }
            }
        }

        const manufacturer = upsInfo['device.mfr'] || upsInfo['ups.vendorid'] || 'No Manufacturer';
        const model = upsInfo['device.model'] || upsInfo['ups.productid'] || 'No Model';
        const serialNumber = upsInfo['ups.serial'] || 'No Serial';
        const firmwareRevision = upsInfo['ups.firmware'] || 'No Data';

        const ups: Ups = {
            key: upsKey,
            name: upsName,
            fault: !this.nutConnected,
            active,
            onBattery,
            temperature,
            batteryLevel,
            chargingState,
            lowBattery: batteryLevel < this.lowBattThreshold,
            powerConsumption,
            powerConsumptionLevel,
            manufacturer: manufacturer.trim(),
            model: model.trim(),
            serialNumber: serialNumber.trim(),
            firmwareRevision: firmwareRevision.trim()
        };
        
        this.log.debug(`parsed UPS values: ${JSON.stringify(ups)}`);

        return ups;
    }

    async pollNutDevice(upsKey, upsName) {
        this.log.debug(`pollNutDevice(${upsKey}, ${upsName})`);

        new Promise<void>((resolve, reject) => {
            this.nutClient.GetUPSVars(upsKey, (upsVars, err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(upsVars);
            });
        }).then((upsVars) => {
            const ups = this.parseUpsVars(upsKey, upsName, upsVars);
            this.createOrUpdateUps(ups);
        })
            .catch((err) => {
                this.log.error(`error invoking GetUPSVars on nut client for device ${upsKey}=${upsName}: ${err.message}`);
            });
    }

    pollNutDevices() {
        this.log.debug('pollNutDevices()');

        if (!this.nutConnected) {
            this.log.debug('Cannot poll devices as nut client not connected, restarting and waiting for a nutReady event...');

            // (re-)start nut... this will eventually emit the nut ready event
            this.nutClient.start();

            this.log.info(`(re-)started nut client for ${this.host}:${this.port}`);

            return;
        }

        // nut client is ready and connected so we can poll the status of UPS devices
        const entries = Object.entries(this.upsList);
        
        const pollPromises: Array<Promise<void>> = [];
        entries.forEach((entry) => {
            pollPromises.push(this.pollNutDevice(entry[0], entry[1]));
        });

        Promise.all(pollPromises)
            .catch((err) => {
                this.log.error(`error polling nut devices: ${err.message}`);
            })
            .finally(() => {
                const pollTimeout = setTimeout(() => {
                    this.pollNutDevices();
                }, this.pollInterval * 1000);

                // Don't prevent homebridge shutdown
                pollTimeout.unref();
            });
    }

    nutReady() {
        this.log.debug('nutReady()');

        this.nutConnected = true;

        if (!isEmpty(this.upsList)) {
            this.log.info('nutReady() => already initialized, must be a reconnect...');

            // now that we are re-connected start polling again
            this.pollNutDevices();

            return;
        }

        new Promise<object>((resolve, reject) => {
            this.nutClient.GetUPSList((upsList, err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(upsList);
            });
        }).then((upsList) => {

            // store the list of UPS devices
            this.upsList = upsList;

            const entries = Object.entries(upsList);

            if (entries.length === 0) {
                this.log.warn('no UPS devices returned from GetUPSList!');
            } else {
                const deviceList = entries.map((entry) => `${entry[0]}=${entry[1]}`);
                this.log.info(`nut client connected, reported devices: ${deviceList.join(',')}`);
            }

            // now that we are connected we can start polling the UPS devices
            this.pollNutDevices();
        })
            .catch((err) => {
                this.log.error(`error invoking GetUPSList on nut client: ${err.message}`);
            });
    }

    nutClose() {
        this.log.info('nutClose()');
        this.nutConnected = false;
    }

    nutError(error) {
        this.log.error(`nutError(${error})`);
    }

    startNutClient() {
        this.nutClient = new Nut(this.port, this.host);

        this.nutClient.on('ready', this.nutReady.bind(this));
        this.nutClient.on('close', this.nutClose.bind(this));
        this.nutClient.on('error', this.nutError.bind(this));

        // Start nut... this will eventually emit the nut ready event
        this.nutClient.start();

        this.log.info(`started nut client for ${this.host}:${this.port}`);
    }
}
