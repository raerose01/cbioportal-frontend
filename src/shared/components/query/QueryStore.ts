import * as _ from 'lodash';
import client from "../../api/cbioportalClientInstance";
import {toJS, observable, reaction, action, computed, whyRun, expr} from "../../../../node_modules/mobx/lib/mobx";
import {TypeOfCancer as CancerType, GeneticProfile, CancerStudy, SampleList} from "../../api/CBioPortalAPI";
import CancerStudyTreeData from "./CancerStudyTreeData";
import StudyListLogic from "../StudyList/StudyListLogic";
import {remoteData} from "../../api/remoteData";
import {labelMobxPromises} from "../../api/MobxPromise";
import internalClient from "../../api/cbioportalInternalClientInstance";
import {MutSig, Gistic} from "../../api/CBioPortalAPIInternal";

export type PriorityStudies = {
	[category:string]: string[]
};

// mobx observable
export class QueryStore
{
	constructor()
	{
		labelMobxPromises(this);
	}

	@computed get stateToSerialize()
	{
		let keys:Array<keyof this> = [
			'searchText',
			'selectedStudyIds',
			'dataTypePriority',
			'selectedProfileIds',
			'zScoreThreshold',
			'rppaScoreThreshold',
			'selectedSampleListId',
			'caseIds',
			'caseIdsMode',
			'geneSet',
		];
		return _.pick(this, keys);
	}

	////////////////////////////////////////////////////////////////////////////////
	// QUERY PARAMETERS
	////////////////////////////////////////////////////////////////////////////////

	@observable forDownloadTab:boolean = false;

	@observable searchText:string = '';

	@observable.ref selectedStudyIds:ReadonlyArray<string> = [];

	@observable dataTypePriority = {mutation: true, cna: true};

	// genetic profile ids
	@observable.ref private _selectedProfileIds?:ReadonlyArray<string> = undefined; // user selection
	@computed get selectedProfileIds():ReadonlyArray<string>
	{
		if (this._selectedProfileIds !== undefined)
			return this._selectedProfileIds;

		// compute default selection
		const altTypes:GeneticProfile['geneticAlterationType'][] = [
			'MUTATION_EXTENDED',
			'COPY_NUMBER_ALTERATION',
		];
		let ids = [];
		for (let altType of altTypes)
		{
			let profiles = this.getFilteredProfiles(altType);
			if (profiles.length)
				ids.push(profiles[0].geneticProfileId);
		}
		return ids;
	}
	set selectedProfileIds(value:ReadonlyArray<string>)
	{
		this._selectedProfileIds = value;
	}

	@observable zScoreThreshold:string = '2.0';

	@observable rppaScoreThreshold:string = '2.0';

	// sample list id
	@observable private _selectedSampleListId?:string = undefined; // user selection
	@computed get selectedSampleListId()
	{
		if (this._selectedSampleListId !== undefined)
			return this._selectedSampleListId;

		// compute default selection
		let studyId = this.singleSelectedStudyId;
		if (!studyId)
			return undefined;

		let mutSelect = this.isGeneticAlterationTypeSelected('MUTATION_EXTENDED');
		let cnaSelect = this.isGeneticAlterationTypeSelected('COPY_NUMBER_ALTERATION');
		let expSelect = this.isGeneticAlterationTypeSelected('MRNA_EXPRESSION');
		let rppaSelect = this.isGeneticAlterationTypeSelected('PROTEIN_LEVEL');
		let sampleListId = studyId + "_all";

		if (mutSelect && cnaSelect && !expSelect && !rppaSelect)
			sampleListId = studyId + "_cnaseq";
		else if (mutSelect && !cnaSelect && !expSelect && !rppaSelect)
			sampleListId = studyId + "_sequenced";
		else if (!mutSelect && cnaSelect && !expSelect && !rppaSelect)
			sampleListId = studyId + "_acgh";
		else if (!mutSelect && !cnaSelect && expSelect && !rppaSelect)
		{
			if (this.isProfileSelected(studyId + '_mrna_median_Zscores'))
				sampleListId = studyId + "_mrna";
			else if (this.isProfileSelected(studyId + '_rna_seq_mrna_median_Zscores'))
				sampleListId = studyId + "_rna_seq_mrna";
			else if (this.isProfileSelected(studyId + '_rna_seq_v2_mrna_median_Zscores'))
				sampleListId = studyId + "_rna_seq_v2_mrna";
		}
		else if ((mutSelect || cnaSelect) && expSelect && !rppaSelect)
			sampleListId = studyId + "_3way_complete";
		else if (!mutSelect && !cnaSelect && !expSelect && rppaSelect)
			sampleListId = studyId + "_rppa";

		// BEGIN HACK if not found
		if (!this.dict_sampleListId_sampleList[sampleListId])
		{
			if (sampleListId === studyId + '_cnaseq')
				sampleListId = studyId + '_cna_seq';
			else if (sampleListId === studyId + "_3way_complete")
				sampleListId = studyId + "_complete";

		}
		// END HACK

		// if still not found
		if (!this.dict_sampleListId_sampleList[sampleListId])
			sampleListId = studyId + '_all';

		return sampleListId;
	}
	set selectedSampleListId(value)
	{
		this._selectedSampleListId = value;
	}

	@observable caseIds = '';

	@observable caseIdsMode:'sample'|'patient' = 'sample';

	@observable geneSet = '';


	////////////////////////////////////////////////////////////////////////////////
	// VISUAL OPTIONS
	////////////////////////////////////////////////////////////////////////////////

	@observable.ref searchTextPresets:ReadonlyArray<string> = [
		'tcga',
		'tcga -provisional',
		'tcga -moratorium',
		'tcga OR icgc',
		'-"cell line"',
		'prostate mskcc',
		'esophageal OR stomach',
		'serous',
		'breast',
	];
	@observable priorityStudies:PriorityStudies = {
		'Shared institutional Data Sets': ['mskimpact', 'cellline_mskcc'],
		'Priority Studies': ['blca_tcga_pub', 'coadread_tcga_pub', 'brca_tcga_pub2015'], // for demo
	};
	@observable showSelectedStudiesOnly:boolean = false;
	@observable.shallow selectedCancerTypeIds:string[] = [];
	@observable maxTreeDepth:number = 9;
	@observable clickAgainToDeselectSingle:boolean = true;


	////////////////////////////////////////////////////////////////////////////////
	// REMOTE DATA
	////////////////////////////////////////////////////////////////////////////////

	readonly cancerTypes = remoteData(client.getAllCancerTypesUsingGET({}), []);

	readonly cancerStudies = remoteData(client.getAllStudiesUsingGET({}), []);

	readonly geneticProfiles = remoteData<GeneticProfile[]>({
		invoke: () => {
			if (this.singleSelectedStudyId)
				return client.getAllGeneticProfilesInStudyUsingGET({studyId: this.singleSelectedStudyId});
			return Promise.resolve([]);
		},
		default: [],
		reaction: () => this._selectedProfileIds = undefined
	});

	readonly sampleLists = remoteData<SampleList[]>({
		invoke: () => {
			if (this.singleSelectedStudyId)
				return (
					client.getAllSampleListsInStudyUsingGET({
						studyId: this.singleSelectedStudyId,
						projection: 'DETAILED'
					}).then(
						sampleLists => _.sortBy(sampleLists, sampleList => sampleList.name)
					)
				);
			return Promise.resolve([]);
		},
		default: [],
		reaction: () => this._selectedSampleListId = undefined
	});

	readonly mutSigForSingleStudy = remoteData<MutSig[]>({
		invoke: () => {
			if (this.singleSelectedStudyId)
				return internalClient.getSignificantlyMutatedGenesUsingGET({studyId: this.singleSelectedStudyId});
			return Promise.resolve([]);
		},
		default: []
	});

	readonly gisticForSingleStudy = remoteData<Gistic[]>({
		invoke: () => {
			if (this.singleSelectedStudyId)
				return internalClient.getSignificantCopyNumberRegionsUsingGET({studyId: this.singleSelectedStudyId});
			return Promise.resolve([]);
		},
		default: []
	});


	////////////////////////////////////////////////////////////////////////////////
	// DERIVED DATA
	////////////////////////////////////////////////////////////////////////////////

	// CANCER STUDY

	@computed get treeData()
	{
		return new CancerStudyTreeData({
			cancerTypes: this.cancerTypes.result,
			studies: this.cancerStudies.result,
			priorityStudies: this.priorityStudies,
		});
	}

	@computed get studyListLogic()
	{
		// temporary hack - dependencies
		// TODO review StudyListLogic code
		this.treeData;
		this.maxTreeDepth;
		this.searchText;
		this.selectedCancerTypeIds;
		this.selectedStudyIds;
		this.showSelectedStudiesOnly;

		return new StudyListLogic(this);
	}

	@computed get singleSelectedStudyId()
	{
		return this.selectedStudyIds.length == 1 ? this.selectedStudyIds[0] : undefined;
	}

	@computed get selectedStudies()
	{
		return this.selectedStudyIds.map(id => this.treeData.map_studyId_cancerStudy.get(id));
	}

	@computed get selectedStudies_totalSampleCount()
	{
		return this.selectedStudies.reduce((sum:number, study:CancerStudy) => sum + study.allSampleCount, 0);
	}

	// GENETIC PROFILE

	@computed get dict_geneticProfileId_geneticProfile():_.Dictionary<GeneticProfile | undefined>
	{
		return _.keyBy(this.geneticProfiles.result, profile => profile.geneticProfileId);
	}

	getFilteredProfiles(geneticAlterationType:GeneticProfile['geneticAlterationType'])
	{
		return this.geneticProfiles.result.filter(profile => {
			if (profile.geneticAlterationType != geneticAlterationType)
				return false;

			return profile.showProfileInAnalysisTab || this.forDownloadTab;
		});
	}

	isProfileSelected(geneticProfileId:string)
	{
		return _.includes(this.selectedProfileIds, geneticProfileId);
	}

	isGeneticAlterationTypeSelected(geneticAlterationType:GeneticProfile['geneticAlterationType']):boolean
	{
		return this.selectedProfileIds.some(profileId => {
			let profile = this.dict_geneticProfileId_geneticProfile[profileId];
			return !!profile && profile.geneticAlterationType == geneticAlterationType;
		});
	}

	// SAMPLE LIST

	@computed get dict_sampleListId_sampleList():_.Dictionary<SampleList | undefined>
	{
		return _.keyBy(this.sampleLists.result, sampleList => sampleList.sampleListId);
	}

	// GENE SET

	////////////////////////////////////////////////////////////////////////////////
	// ACTIONS
	////////////////////////////////////////////////////////////////////////////////

	@action selectCancerType(cancerType:CancerType, multiSelect?:boolean)
	{
		let clickedCancerTypeId = cancerType.cancerTypeId;

		if (multiSelect)
		{
			if (_.includes(this.selectedCancerTypeIds, clickedCancerTypeId))
				this.selectedCancerTypeIds = _.difference(this.selectedCancerTypeIds, [clickedCancerTypeId]);
			else
				this.selectedCancerTypeIds = _.union(this.selectedCancerTypeIds, [clickedCancerTypeId]);
		}
		else if (this.clickAgainToDeselectSingle && _.isEqual(toJS(this.selectedCancerTypeIds), [clickedCancerTypeId]))
		{
			this.selectedCancerTypeIds = [];
		}
		else
		{
			this.selectedCancerTypeIds = [clickedCancerTypeId];
		}
	}
}

const queryStore = (window as any).queryStore = new QueryStore();
export default queryStore;
