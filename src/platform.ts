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

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { NutUPSAccessory, Ups } from './nutUpsAccessory.js';

/**
 * NutHomebridgePlatform
 */
export class NutHomebridgePlatform implements DynamicPlatformPlugin {

    public readonly Service!: typeof Service;
    public readonly Characteristic!: typeof Characteristic;

    // this is used to track restored cached accessories
    public readonly existingAccessories: PlatformAccessory[] = [];

    // this is used to have a reference to UPS accessory handles to update state after polling nut client
    private upsByUpsKey = new Map<string, NutUPSAccessory>();

    // this is true if the nut client is currently attempting connection
    private nutConnecting = false;

    // this is true if the nut client is connected
    private nutConnected = false;

    // this is true if the nut client is currently polling UPS devices
    private nutPolling = false;

    // this will be populated with the list of devices returned from the nut client
    private upsList;

    private readonly host: string;
    private readonly port: number;
    private readonly username: string;
    private readonly password: string;
    private readonly pollInterval: number;
    private readonly connectInterval: number;
    private readonly commandInterval: number;
    private readonly lowBattThreshold: number;
    private readonly upsKeyExcludes: Array<string>;

    private nutClient;

    commandDelay(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, this.commandInterval * 1000));
    }

    constructor(
        public readonly log: Logger,
        public readonly config: PlatformConfig,
        public readonly api: API
    ) {
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;

        log.debug('finished initializing platform');

        this.host = config.host || 'localhost';
        this.port = config.port || 3493;
        this.config = config;
        this.username = config.username;
        this.password = config.password;
        this.pollInterval = config.poll_interval || 60;
        this.connectInterval = config.connect_interval || 5;
        this.commandInterval = config.command_interval || 1;
        this.lowBattThreshold = config.low_batt_threshold || 40;
        this.upsKeyExcludes = config.ups_key_excludes || [];

        // When this event is fired it means Homebridge has restored all cached accessories from disk.
        api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
            log.debug('didFinishLaunching callback');

            this.startPolling();
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
        // the cached devices we stored in the `configureAccessory` method above
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
            this.upsByUpsKey.set(ups.key, nutUPSAccessory);

            // link the accessory to your platform
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }

        // now that we know an accessory exists, update it
        nutUPSAccessory.update(ups);
    }

    parseUpsVars(upsKey, upsName, upsVars) {
        this.log.debug(`parseUpsVars(${upsKey})`);

        const upsInfo: Record<string, string> = {};

        this.log.debug(`UPS info for device: ${upsKey}=${upsName} =>`);

        Object.entries(upsVars).forEach(([key, value]) => {

            this.log.debug(`${key}=${value}`);
            upsInfo[key] = value as string;
        });

        let active = false;
        if ('ups.load' in upsInfo) {
            const load = parseInt(upsInfo['ups.load']);
            active = (load !== undefined) && !isNaN(load) && (load > 0);
        }

        let onBattery = false;
        if ('ups.status' in upsInfo) {
            const status = upsInfo['ups.status'] as string;
            onBattery = status.trim().split(' ').includes('OB');
        }

        let temperature = NaN;
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
        } else {
            this.log.warn(`battery.charge not reported by NUT for ${upsKey}; battery level will be reported as 0`);
        }

        let chargingState = this.Characteristic.ChargingState.NOT_CHARGING;
        if ('ups.status' in upsInfo) {
            const upsStatus = upsInfo['ups.status'] as string;
            const statusFlags = upsStatus.trim().split(' ');
            if (statusFlags.includes('OB')) {
                chargingState = this.Characteristic.ChargingState.NOT_CHARGEABLE;
            } else if (statusFlags.includes('CHRG')) {
                chargingState = this.Characteristic.ChargingState.CHARGING;
            }
        }

        let powerConsumption = NaN;
        let powerConsumptionLevel = NaN;

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

        // NUT manual says ups variables mirror device variables and will eventually be removed,
        // so prefer device values over ups values
        let manufacturer = upsInfo['device.mfr'] || upsInfo['ups.mfr'] || '';
        let model = upsInfo['device.model'] || upsInfo['ups.model'] || '';
        let serialNumber = upsInfo['device.serial'] || upsInfo['ups.serial'] || '';
        let firmwareRevision = upsInfo['ups.firmware'] || '';

        if (manufacturer.trim() === '') {
            manufacturer = 'Unknown';
        }
        if (model.trim() === '') {
            model = 'Unknown';
        }
        if (serialNumber.trim() === '') {
            serialNumber = 'Unknown';
        }
        if (firmwareRevision.trim() === '') {
            firmwareRevision = 'Unknown';
        }

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

    pollNutDevice(upsKey, upsName): Promise<void> {
        this.log.debug(`pollNutDevice(${upsKey}, ${upsName})`);

        return new Promise<void>((resolve, reject) => {
            this.nutClient.GetUPSVars(upsKey, (upsVars, err) => {
                if (err) {
                    this.log.debug('nut client: get UPS vars error');
                    reject(err);
                    return;
                }
                this.log.debug('nut client: get UPS vars success');
                resolve(upsVars);
            });
        }).then((upsVars) => {
            const ups = this.parseUpsVars(upsKey, upsName, upsVars);

            this.log.debug('parseUpsVars() success');

            this.createOrUpdateUps(ups);

            this.log.debug('createOrUpdateUps() success');
        }).then(() => {
            // delay after get UPS Vars command
            return this.commandDelay();
        })
            .catch((err) => {
                this.log.error(`error invoking GetUPSVars on nut client for device ${upsKey}=${upsName}: ${err.message}`);
            });
    }

    async pollNutDevices() {
        this.log.debug('pollNutDevices()');

        this.nutPolling = true;

        // nut client is ready and connected so we can poll the status of UPS devices
        const pollTasks: Array<() => Promise<void>> = [];
        this.upsList.forEach((entry) => {
            const key = entry[0];
            let name = entry[1];

            // If no description configured in nut to use as the name, use the key instead
            if (name === 'Description unavailable') {
                name = key;
            }
            pollTasks.push(() => {
                return this.pollNutDevice(key, name);
            });
        });

        await pollTasks.reduce((p, task) => p.then(task), Promise.resolve());

        this.nutPolling = false;
    }

    nutReady() {
        this.log.debug('nutReady()');

        return Promise.resolve()
            .then(() => {
                if (this.username === undefined) {
                    return;
                }
                return new Promise<object | void>((resolve, reject) => {
                    this.nutClient.SetUsername(this.username, (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        resolve();
                        this.log.debug('nut client: username set success');
                    });
                }).then(() => {
                    // delay after username command
                    return this.commandDelay();
                });
            }).then(() => {
                if (this.password === undefined) {
                    return;
                }
                return new Promise<object | void>((resolve, reject) => {
                    this.nutClient.SetPassword(this.password, (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        resolve();
                        this.log.debug('nut client: password set success');
                    });
                }).then(() => {
                    // delay after password command
                    return this.commandDelay();
                });
            }).then(() => {

                let upsList = [];

                return new Promise<object | void>((resolve, reject) => {

                    this.nutClient.GetUPSList((upsListResponse, err) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        upsList = upsListResponse;
                        resolve();
                        this.log.debug('nut client: ups list success');
                    });
                }).then(() => {
                    // delay after get UPS List command
                    return this.commandDelay();
                }).then(() => {
                    return upsList;
                });
            }).then((upsList) => {

                if (Object.entries(upsList).length === 0) {
                    this.log.warn('no UPS devices returned from GetUPSList!');
                }

                // store the list of filtered UPS devices
                this.upsList = Object.entries(upsList).filter((entry) => {
                    return (this.upsKeyExcludes.length === 0) || !this.upsKeyExcludes.find(element => element === entry[0]);
                });

                if (this.upsList.length === 0) {
                    if (this.upsKeyExcludes.length > 0) {
                        this.log.warn('no UPS devices found after applying configured key excludes');
                    }
                } else {
                    const deviceList = this.upsList.map((entry) => `${entry[0]}=${entry[1]}`);
                    this.log.debug(`nut client connected, reported devices: ${deviceList.join(',')}`);
                }

                this.nutConnected = true;
            })
            .catch((err) => {
                this.log.error(`error invoking GetUPSList on nut client: ${err.message}`);
            })
            .finally(() => {
                this.nutConnecting = false;
            });
    }

    nutClose() {
        this.log.debug('nutClose()');

        this.nutConnecting = false;
        this.nutConnected = false;
    }

    nutError(error) {
        this.log.error(`nutError(${error})`);
    }

    startPolling() {
        this.log.debug('startPolling()');

        // Periodically check if UPS devices should be polled
        const pollInterval = setInterval(async () => {

            if (this.nutConnected && !this.nutPolling) {
                await this.pollNutDevices();
            }
        }, this.pollInterval * 1000);

        // Don't prevent homebridge shutdown
        pollInterval.unref();

        // Periodically check if nut client should attempt to connect
        const connectInterval = setInterval(() => {

            if (!this.nutConnected && !this.nutConnecting) {

                this.nutConnecting = true;

                this.log.debug(`creating nut client for ${this.host}:${this.port}`);

                this.nutClient = new Nut(this.port, this.host);

                this.nutClient.on('ready', this.nutReady.bind(this));
                this.nutClient.on('close', this.nutClose.bind(this));
                this.nutClient.on('error', this.nutError.bind(this));

                this.log.debug(`starting nut client for ${this.host}:${this.port}`);

                // Start nut... this will eventually emit the nut ready event
                this.nutClient.start();
            }
        }, this.connectInterval * 1000);

        // Don't prevent homebridge shutdown
        connectInterval.unref();
    }
}
