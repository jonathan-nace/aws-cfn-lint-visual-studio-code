/*
Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License").
You may not use this file except in compliance with the License.
A copy of the License is located at

    http://www.apache.org/licenses/LICENSE-2.0

or in the "license" file accompanying this file. This file is distributed
on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
express or implied. See the License for the specific language governing
permissions and limitations under the License.
*/
'use strict';

import {
	Files, IPCMessageReader, IPCMessageWriter, createConnection, IConnection, TextDocuments, TextDocument,
	Diagnostic, DiagnosticSeverity, InitializeResult
} from 'vscode-languageserver';

import { spawn } from "child_process";

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
connection.onInitialize((): InitializeResult => {
	return {
		capabilities: {
			// Tell the client that the server works in FULL text document sync mode
			textDocumentSync: documents.syncKind,
			// Tell the client that the server support code complete
			completionProvider: {
				resolveProvider: true
			}
		}
	};
});

// The content of a CloudFormation document has saved. This event is emitted
// when the document get saved
documents.onDidSave((event) => {
	console.log('Running cfn-lint...');
	validateCloudFormationFile(event.document);
});

documents.onDidOpen((event) => {
	validateCloudFormationFile(event.document);
});

// The settings interface describe the server relevant settings part
interface Settings {
	cfnLint: CloudFormationLintSettings;
}

// These are the example settings we defined in the client's package.json
// file
interface CloudFormationLintSettings {
	path: string;
}

// hold the Path setting
let Path: string;
// The settings have changed. Is send on server activation as well.
connection.onDidChangeConfiguration((change) => {
	console.log('Settings have been updated...');
	let settings = <Settings>change.settings;
	console.log('Settings: ' + settings);
	Path = settings.cfnLint.path || 'cfn-lint';
	// Revalidate any open text documents
	console.log('Path set to: ' + Path);
	documents.all().forEach(validateCloudFormationFile);
});

let isValidating: { [index: string]: boolean } = {};


function convertSeverity(mistakeType: string): DiagnosticSeverity {

	switch (mistakeType) {
		case "Warning":
			return DiagnosticSeverity.Warning;
		case "Information":
			return DiagnosticSeverity.Information;
		case "Hint":
			return DiagnosticSeverity.Hint;
	}
	return DiagnosticSeverity.Error;
}

function validateCloudFormationFile(document: TextDocument): void {
	let uri = document.uri;

	if (isValidating[uri]) {
		return;
	}

	isValidating[uri] = true;

	let file_to_lint = Files.uriToFilePath(uri);

	let is_cfn_regex = new RegExp('"?AWSTemplateFormatVersion"?\s*');
	let is_cfn = false;
	let text = document.getText().split("\n");
	for (var index in text) {
		if (is_cfn_regex.exec(text[index])) {
			is_cfn = true;
		}
	}

	connection.console.log("Is CFN: " + is_cfn);
	let args = ['--format', 'json', '--template', file_to_lint];

	connection.console.log(`running............. ${Path} ${args}`);

	let child = spawn(
		Path,
		args
	);

	let diagnostics: Diagnostic[] = [];
	let filename = uri.toString();
	let start = 0;
	let end = Number.MAX_VALUE;

	child.stderr.on("data", (data: Buffer) => {
		let err = data.toString();
		connection.console.log(err);
		let lineNumber = 0;
		let diagnostic: Diagnostic = {
			range: {
				start: { line: lineNumber, character: start },
				end: { line: lineNumber, character: end }
			},
			severity: DiagnosticSeverity.Warning,
			message: err
		};
		diagnostics.push(diagnostic);
	});

	let stdout = "";
	child.stdout.on("data", (data: Buffer) => {
		stdout = stdout.concat(data.toString());
	});

	child.on('exit', function (code, signal) {
		console.log('child process exited with ' +
					`code ${code} and signal ${signal}`);
		let tmp = stdout.toString();
		let obj = JSON.parse(tmp);
		for(let element of obj) {
			let lineNumber = (Number.parseInt(element.Location.Start.LineNumber) - 1);
			let columnNumber = (Number.parseInt(element.Location.Start.ColumnNumber) - 1);
			let lineNumberEnd = (Number.parseInt(element.Location.End.LineNumber) - 1);
			let columnNumberEnd = (Number.parseInt(element.Location.End.ColumnNumber) - 1);
			let diagnostic: Diagnostic = {
				range: {
					start: { line: lineNumber, character: columnNumber },
					end: { line: lineNumberEnd, character: columnNumberEnd }
				},
				severity: convertSeverity(element.Level),
				message: element.Message
			};
			if (is_cfn) {
				diagnostics.push(diagnostic);
			}
		}
	});

	child.on("close", () => {
		//connection.console.log(`Validation finished for(code:${code}): ${Files.uriToFilePath(uri)}`);
		connection.sendDiagnostics({ uri: filename, diagnostics });
		isValidating[uri] = false;
	});
}

// Listen on the connection
connection.listen();
