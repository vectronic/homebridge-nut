'use strict';

const util = require('util');
const EventEmitter = require('events').EventEmitter;
const Nut = require('node-nut');
const pEvent = require('p-event');
const _ = require('lodash');

let Service;
let Characteristic;


/**
 * Platform "Nut"
 */

function NutPlatform(log, config) {

    this.log = log;
    this.config = config;

    this.host = config['host'] || 'localhost';
    this.port = config['port'] || 3493;

    this.nut = new Nut(this.port, this.host);

    this.nut.on('ready', this.nutReady.bind(this));
    this.nut.on('close', this.nutClose.bind(this));
    this.nut.on('error', this.nutError.bind(this));

    // this will be populated in the nutReady event handler
    this.upsInfo = {};

    // this is true if we last received a nutReady (and not a nutClose) event
    this.nutConnected = false;

    EventEmitter.call(this);
}


// Enable our platform to be an event emitter
util.inherits(NutPlatform, EventEmitter);


NutPlatform.prototype.accessories = function (callback) {

    // Listen for an initialized event emitted from ourselves, then setup a UPS accessory and finally perform callback
    (async () => {
        try {
            await pEvent(this, 'initialized');
            this.log('platform initialized event');

            // Create an accessory and callback
            if (_.isEmpty(this.upsInfo)) {
                this.log('Initialised event received, but no upsInfo - no accessory created!');
                callback([]);
            } else {
                this.nutAccessory = new NutAccessory(this, this.log, this.config, this.upsInfo);
                callback([this.nutAccessory]);
            }
        } catch (error) {
            this.log(`platform error event - no accessory created! - ${error}`);

            // Callback with no accessories
            callback([]);
        }
    })();

    // Start nut...
    // This will eventually emit the nut ready event..
    // which will in turn cause the platform to emit the initialized event...
    // which we are awaiting above
    this.nut.start();

    this.log(`Started nut client for ${this.host}:${this.port}`);
};


NutPlatform.prototype.pollNut = function (callback) {

    if (!this.nutConnected) {
        this.log('Cannot poll nut as currently not connected, restarting and waiting for a nutReady event...');

        this.nut.start();
        this.log(`Re-started nut client for ${this.host}:${this.port}`);

        callback();
        return;
    }

    const that = this;

    this.nut.GetUPSVars(this.upsKey, function (upsVars, err) {

        if (err) {
            callback(err);
        } else {
            // parse results and setup upsInfo
            Object.entries(upsVars).forEach(([key, value]) => {
                that.upsInfo[key] = value;
            });

            callback();
        }
    });
};


NutPlatform.prototype.nutReady = function () {
    this.log('nutReady');

    this.nutConnected = true;

    if (!_.isEmpty(this.upsInfo)) {
        this.log('nutReady: already initialized, must be a reconnect...');
        return;
    }

    const that = this;

    this.nut.GetUPSList((upsList, err) => {
        if (err) {
            that.log(`error calling GetUPSList: ${err}`);
            // emit error event
            that.emit('error', err);
            return;
        }

        const entries = Object.entries(upsList);

        if (entries.length === 0) {
            this.log('no UPS returned from GetUPSList!');
            that.emit('initialized');
            return;
        }

        if (entries.length > 1) {
            this.log('More than one UPS returned from GetUPSList, only the first will be added as an accessory!');
        }

        // Save the first UPS key and name as used for future nut requests and to name accessory
        that.upsKey = entries[0][0];
        that.upsName = entries[0][1];

        // Get the ups vars and request callback so we can emit initialized event
        that.pollNut((err) => {

            if (err) {
                that.log(`error calling pollNut: ${err}`);
                // emit error event
                that.emit('error', err);
                return;
            }

            // finally emit initialized event
            that.emit('initialized');
        });
    });
};


NutPlatform.prototype.nutClose = function () {
    this.log('nutClose');

    this.nutConnected = false;
};


NutPlatform.prototype.nutError = function (error) {
    this.log(`nutError: ${error}`);
};


/**
 * Accessory "Nut"
 */

function NutAccessory(platform, log, config, upsInfo) {

    // maintain a reference to the platform so we can monitor the nutConnected state and poll nut
    this.platform = platform;

    this.log = log;

    this.lowBattThreshold = config['low_batt_threshold'] || 40;
    this.pollInterval = config['poll_interval'] || 60;

    // this.nutName = accessory;
    this.name = platform.upsName;

    this.upsInfo = upsInfo;

    // Start polling and updating state
    this.pollNutAndUpdateState();
}


NutAccessory.prototype.pollNutAndUpdateState = function () {

    const that = this;
    this.platform.pollNut((err) => {

        if (err) {
            that.log(`error calling pollNut: ${err}`);
        } else {
            that.updateState();
        }
        const pollTimeout = setTimeout(function () {
            that.pollNutAndUpdateState();
        }, that.pollInterval * 1000);

        // Don't prevent homebridge shutdown
        pollTimeout.unref();
    });
};


NutAccessory.prototype.getState = function (callback) {

    const that = this;
    this.platform.pollNut((err) => {

        if (err) {
            that.log(`error calling pollNut, probably an ongoing request: ${err}`);
        } else {
            that.updateState();
        }
        callback();
    });
};


NutAccessory.prototype.updateState = function () {

    if (!this.platform.nutConnected) {
        this.log('nutConnected is false, setting StatusFault');
        this.contactSensorService.setCharacteristic(Characteristic.StatusFault, 1);
        return;
    }

    this.contactSensorService.setCharacteristic(Characteristic.StatusFault, 0);

    if (this.upsInfo['ups.status'].startsWith('OB')) {
        this.contactSensorService.setCharacteristic(Characteristic.ContactSensorState, 1);
    } else {
        this.contactSensorService.setCharacteristic(Characteristic.ContactSensorState, 0);
    }

    const load = parseInt(this.upsInfo['ups.load']);
    if (!isNaN(load) && (load > 0)) {
        this.contactSensorService.setCharacteristic(Characteristic.StatusActive, 1);
    } else {
        this.contactSensorService.setCharacteristic(Characteristic.StatusActive, 0);
    }

    if ('ups.temperature' in this.upsInfo) {
        const temp = parseFloat(this.upsInfo['ups.temperature']);
        if (!isNaN(temp)) {
            this.contactSensorService.setCharacteristic(Characteristic.CurrentTemperature, temp);
        }
    }

    const charge = parseFloat(this.upsInfo['battery.charge'])
    if (!isNaN(charge)) {
        this.batteryService.setCharacteristic(Characteristic.BatteryLevel, charge);
    }

    const upsStatus = this.upsInfo['ups.status'];
    if (upsStatus === 'OL CHRG' || upsStatus === 'OL') {
        this.batteryService.setCharacteristic(Characteristic.ChargingState, 1);
    } else if (upsStatus === 'OB DISCHRG' || upsStatus === 'OB') {
        this.batteryService.setCharacteristic(Characteristic.ChargingState, 2);
    } else {
        this.batteryService.setCharacteristic(Characteristic.ChargingState, 0);
    }

    const threshold = parseInt(this.lowBattThreshold);

    if (!isNaN(charge) && !isNaN(threshold) && (charge < threshold)) {
        this.batteryService.setCharacteristic(Characteristic.StatusLowBattery, 1);
    } else {
        this.batteryService.setCharacteristic(Characteristic.StatusLowBattery, 0);
    }

    if ('ups.load' in this.upsInfo && 'ups.power.nominal' in this.upsInfo) {
        const loadPercent = parseInt(this.upsInfo['ups.load']);
        const nominalPower = parseInt(this.upsInfo['ups.power.nominal']);
        const loadWatt = loadPercent * 0.01 * nominalPower * 0.8;

        if (!isNaN(loadWatt)) {
            this.contactSensorService.setCharacteristic(Characteristic.UpsPowerConsumption, Math.round(loadWatt));
        }
        if (!isNaN(loadPercent)) {
            this.contactSensorService.setCharacteristic(Characteristic.UpsPowerConsumptionLevel, loadPercent);
        }
    }
};


NutAccessory.prototype.getServices = function () {

    const contactSensorService = new Service.ContactSensor(this.name);

    // if UPS Status starts with 'OB'
    contactSensorService.getCharacteristic(Characteristic.ContactSensorState)
        .on('get', this.getState.bind(this));

    // if UPS Load is > 0
    contactSensorService.addCharacteristic(Characteristic.StatusActive);

    // if NUT is not reachable
    contactSensorService.addCharacteristic(Characteristic.StatusFault);
    contactSensorService.addCharacteristic(Characteristic.CurrentTemperature);
    contactSensorService.addCharacteristic(Characteristic.UpsPowerConsumption);
    contactSensorService.addCharacteristic(Characteristic.UpsPowerConsumptionLevel);

    this.contactSensorService = contactSensorService;

    const batteryService = new Service.BatteryService();
    batteryService.setCharacteristic(Characteristic.Name, this.name);
    batteryService.setCharacteristic(Characteristic.BatteryLevel, this.upsInfo['battery.charge']);
    batteryService.setCharacteristic(Characteristic.ChargingState, 0);
    batteryService.setCharacteristic(Characteristic.StatusLowBattery, 0);

    this.batteryService = batteryService;

    const accessoryInformationService = new Service.AccessoryInformation();

    accessoryInformationService.setCharacteristic(Characteristic.Manufacturer,
        this.upsInfo['device.mfr'] || this.upsInfo['ups.vendorid'] || 'No Manufacturer');
    accessoryInformationService.setCharacteristic(Characteristic.Name, this.name);
    accessoryInformationService.setCharacteristic(Characteristic.SerialNumber, this.upsInfo['ups.serial'] || 'No Serial');
    accessoryInformationService.setCharacteristic(Characteristic.FirmwareRevision, this.upsInfo['ups.firmware'] || 'No Data');
    accessoryInformationService.setCharacteristic(Characteristic.Model,
        this.upsInfo['device.model'].trim() || this.upsInfo['ups.productid'] || 'No Model');

    return [
        accessoryInformationService,
        contactSensorService,
        batteryService
    ];
};


module.exports = function (homebridge) {

    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    // Custom characteristics

    const upsPowerConsumptionUuid = '0C94EF35-4F4D-4B2F-AA64-249998724F0B';
    Characteristic.UpsPowerConsumption = function () {
        Characteristic.call(this, 'Consumption', upsPowerConsumptionUuid);
        this.setProps({
            format: Characteristic.Formats.UINT16,
            unit: "watts",
            maxValue: 1000000000,
            minValue: 0,
            minStep: 1,
            perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
    };
    util.inherits(Characteristic.UpsPowerConsumption, Characteristic);
    Characteristic.UpsPowerConsumption.UUID = upsPowerConsumptionUuid;

    const upsPowerConsumptionLevelUuid = '0C94EF36-4F4D-4B2F-AA64-249998724F0B';
    Characteristic.UpsPowerConsumptionLevel = function () {
        Characteristic.call(this, 'Consumption Level', upsPowerConsumptionLevelUuid);
        this.setProps({
            format: Characteristic.Formats.UINT16,
            unit: "%",
            maxValue: 100,
            minValue: 0,
            minStep: 1,
            perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
        });
        this.value = this.getDefaultValue();
    };
    util.inherits(Characteristic.UpsPowerConsumptionLevel, Characteristic);
    Characteristic.UpsPowerConsumptionLevel.UUID = upsPowerConsumptionLevelUuid;

    homebridge.registerPlatform('homebridge-nut', 'Nut', NutPlatform);
};
