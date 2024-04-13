#!/usr/bin/env node
"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var _a, _b, _c, _d;
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const client_iam_1 = require("@aws-sdk/client-iam");
const client_ec2_1 = require("@aws-sdk/client-ec2");
const date_fns_1 = require("date-fns");
var resourceTypes;
(function (resourceTypes) {
    resourceTypes["role"] = "role";
    resourceTypes["securityGroup"] = "security-group";
})(resourceTypes || (resourceTypes = {}));
const availableResourceTypes = [resourceTypes.role, resourceTypes.securityGroup];
const defaultIdleTimeValue = 30;
const defaultRegion = 'eu-west-1';
const defaultIncludeUndefined = false;
const defaultCommitedRun = false;
const deleteYesLabel = 'yes';
const deleteNoLabel = 'no';
commander_1.program
    .description('Manage your stale AWS resources.')
    .requiredOption(`-rt, --resource-type <resource-type>`, `Specify what type of resources to scan. (${availableResourceTypes.join('|')})`)
    .option(`-r, --region <region>`, `Region to execute the scipt in. Default:  ${defaultRegion}`)
    .option(`-i, --idle-time <time-in-days>`, `The time, in days, the resource should be unused before deletion. Default: ${defaultIdleTimeValue}`)
    .option(`-c, --commit`, `If this flag is true, resources will actually be deleted.`)
    .option(`-u, --include-undefined`, `Flag to set if you want to delete resources that have not been used yet.`)
    .parse(process.argv);
const options = commander_1.program.opts();
const resourceType = options.resourceType;
const idleTimeInDays = (_a = options.idleTime) !== null && _a !== void 0 ? _a : defaultIdleTimeValue;
const region = (_b = options.regon) !== null && _b !== void 0 ? _b : defaultRegion;
const includeUndefined = (_c = options.includeUndefined) !== null && _c !== void 0 ? _c : defaultIncludeUndefined;
const commitedRun = (_d = options.commit) !== null && _d !== void 0 ? _d : defaultCommitedRun;
// Input validation
if (!availableResourceTypes.includes(resourceType)) {
    console.error(`Please select a resource type from the following list: ${availableResourceTypes.join(', ')}. Given: ${resourceType}`);
}
// Logic
const askQuestion = (q) => __awaiter(void 0, void 0, void 0, function* () {
    return yield new Promise(resolve => {
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });
        readline.question(q, (input) => {
            readline.close();
            resolve(input);
        });
    });
});
const checkDryRunOrThrow = () => {
    if (commitedRun === false) {
        console.log(`To continue, run with option '-c'`);
        throw 'Dry run enabled.';
    }
};
const manageRoles = () => __awaiter(void 0, void 0, void 0, function* () {
    const client = new client_iam_1.IAMClient({ region: region });
    try {
        const dateSinceIdle = (0, date_fns_1.subDays)(new Date(), idleTimeInDays);
        const listRolesCommand = new client_iam_1.ListRolesCommand({});
        const rolesResponse = yield client.send(listRolesCommand);
        const roles = rolesResponse.Roles || [];
        const rolesToDelete = [];
        for (const role of roles) {
            // ListRoles does not include the property for lastUsed so we have to make individual requests
            const getRoleCommand = new client_iam_1.GetRoleCommand({ RoleName: role.RoleName });
            // This should be refactored to leverage Promise.await();
            const roleResponse = yield client.send(getRoleCommand);
            if (roleResponse.Role === undefined) {
                throw `Role ${role.RoleName} not found.`;
            }
            const roleDetails = roleResponse.Role;
            if (roleDetails.RoleLastUsed === undefined || roleDetails.RoleLastUsed.LastUsedDate === undefined) {
                if (includeUndefined) {
                    rolesToDelete.push(roleDetails);
                    console.log(`- ${roleDetails.RoleName}, ${roleDetails.Arn} - undefined`);
                    console.log(`${rolesToDelete.length}/${roles.length}`);
                }
            }
            else if ((0, date_fns_1.isAfter)(dateSinceIdle, roleDetails.RoleLastUsed.LastUsedDate)) {
                rolesToDelete.push(role);
                console.log(`- ${roleDetails.RoleName}, ${roleDetails.Arn} - ${roleDetails.RoleLastUsed.LastUsedDate}`);
                console.log(`${rolesToDelete.length}/${roles.length}`);
            }
        }
        console.log(`Can delete ${rolesToDelete.length} roles. Delete?`);
        const deleteConfirmation = yield askQuestion(`Delete? (${deleteYesLabel}|${deleteNoLabel}): `);
        if (deleteConfirmation === deleteYesLabel) {
            checkDryRunOrThrow();
            console.log('Deleting..');
            for (const role of rolesToDelete) {
                const deleteRoleCommand = new client_iam_1.DeleteRoleCommand({
                    RoleName: role.RoleName
                });
                yield client.send(deleteRoleCommand);
                console.log(`Deleted role ${role.RoleName}`);
            }
            console.log("Finished deleting roles.");
        }
        else {
            console.log('Canceled.');
        }
    }
    catch (error) {
        console.error('Error:', error);
    }
    finally {
        client.destroy();
    }
});
const manageSecurityGroups = () => __awaiter(void 0, void 0, void 0, function* () {
    const client = new client_ec2_1.EC2Client({ region: region });
    try {
        // First fetch all security groups
        const securityGroupsResponse = yield client.send(new client_ec2_1.DescribeSecurityGroupsCommand({}));
        const securityGroups = securityGroupsResponse.SecurityGroups || [];
        const usedSecurityGroupIds = new Set();
        // Then loop over network interfaces. If there are no network interfaces that are linked with a
        // security group, the security group is unused.
        const networkInterfacesResponse = yield client.send(new client_ec2_1.DescribeNetworkInterfacesCommand({}));
        const networkInterfaces = networkInterfacesResponse.NetworkInterfaces || [];
        for (const networkInterface of networkInterfaces) {
            if (networkInterface.Groups !== undefined) {
                for (const group of networkInterface.Groups) {
                    usedSecurityGroupIds.add(group.GroupId || '');
                }
            }
        }
        const unusedSecurityGroups = securityGroups.filter(group => !usedSecurityGroupIds.has(group.GroupId || ''));
        console.log('Unused Security Groups:');
        for (const group of unusedSecurityGroups) {
            console.log(`- ${group.GroupId}: ${group.GroupName}`);
        }
        const deleteConfirmation = yield askQuestion(`Delete? (${deleteYesLabel}|${deleteNoLabel}): `);
        if (deleteConfirmation === deleteYesLabel) {
            checkDryRunOrThrow();
            console.log('Deleting..');
            for (const sg of unusedSecurityGroups) {
                const deleteSGCommand = new client_ec2_1.DeleteSecurityGroupCommand({
                    GroupId: sg.GroupId
                });
                yield client.send(deleteSGCommand);
                console.log(`Deleted role ${sg.GroupName}`);
            }
            console.log("Finished deleting security groups.");
        }
        else {
            console.log('Canceled.');
        }
    }
    catch (error) {
        console.error('Error:', error);
    }
    finally {
        client.destroy();
    }
});
switch (resourceType) {
    case resourceTypes.role:
        manageRoles();
        break;
    case resourceTypes.securityGroup:
        manageSecurityGroups();
        break;
}
